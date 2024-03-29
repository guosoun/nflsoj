const enums = require('./enums');
const util = require('util');
const winston = require('winston');
const msgPack = require('msgpack-lite');
const fs = require('fs-extra');
const interface = require('./judger_interfaces');
const judgeResult = require('./judgeResult');
const retry = require('async-retry')

const judgeStateCache = new Map();
const progressPusher = require('../modules/socketio');
const TaskStatus = interface.TaskStatus;
const TestcaseResultType = interface.TestcaseResultType

function getRunningTaskStatusString(result) {
  let isPending = status => [0, 1].includes(status);
  let allFinished = 0, allTotal = 0;
  for (let subtask of result.judge.subtasks) {
    for (let curr of subtask.cases) {
      allTotal++;
      if (!isPending(curr.status)) allFinished++;
    }
  }

  return `Running ${allFinished}/${allTotal}`;
}

let judgeQueue;

async function connect() {
  const JudgeState = syzoj.model('judge_state');

  const  blockableRedisClient = syzoj.redis.duplicate();
  judgeQueue = {
    redisZADD: util.promisify(syzoj.redis.zadd).bind(syzoj.redis),
    redisBZPOPMAX: util.promisify(blockableRedisClient.bzpopmax).bind(blockableRedisClient),
    async push(data, priority) {
      return await this.redisZADD('judge', priority, JSON.stringify(data));
    },
    async poll(timeout) {
      const result = await this.redisBZPOPMAX('judge', timeout);
      if (!result) return null;

      return {
        data: JSON.parse(result[1]),
        priority: result[2]
      };
    }
  };

  const judgeNamespace = syzoj.socketIO.of('judge');
  judgeNamespace.on('connect', socket => {
    winston.info(`Judge client ${socket.id} connected.`);

    let pendingAckTaskObj = null, waitingForTask = false;
    socket.on('waitForTask', async (token, ack) => {
      // Ignore requests with invalid token.
      if (token != syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted waitForTask with invalid token.`);
        return;
      }

      ack();

      if (waitingForTask) {
        winston.warn(`Judge client ${socket.id} emitted waitForTask, but already waiting, ignoring.`);
        return;
      }

      waitingForTask = true;

      winston.warn(`Judge client ${socket.id} emitted waitForTask.`);

      // Poll the judge queue, timeout = 10s.
      let obj;
      while (socket.connected && !obj) {
        obj = await judgeQueue.poll(10);
      }

      if (!obj) {
        winston.warn(`Judge client ${socket.id} disconnected, stop poll the queue.`);
        // Socket disconnected and no task got.
        return;
      }

      winston.warn(`Judge task ${obj.data.content.taskId} poped from queue.`);

      // Re-push to queue if got task but judge client already disconnected.
      if (socket.disconnected) {
        winston.warn(`Judge client ${socket.id} got task but disconnected re-pushing task ${obj.data.content.taskId} to queue.`);
        judgeQueue.push(obj.data, obj.priority);
        return;
      }

      // Send task to judge client, and wait for ack.
      const task = obj.data;
      pendingAckTaskObj = obj;
      winston.warn(`Sending task ${task.content.taskId} to judge client ${socket.id}.`);
      socket.emit('onTask', msgPack.encode(task), () => {
        // Acked.
        winston.warn(`Judge client ${socket.id} acked task ${task.content.taskId}.`);
        pendingAckTaskObj = null;
        waitingForTask = false;
      });
    });

    socket.on('disconnect', reason => {
      winston.warn(`Judge client ${socket.id} disconnected, reason = ${util.inspect(reason)}.`);
      if (pendingAckTaskObj) {
        // A task sent but not acked, push to queue again.
        winston.warn(`Re-pushing task ${pendingAckTaskObj.data.content.taskId} to judge queue.`);
        judgeQueue.push(pendingAckTaskObj.data, pendingAckTaskObj.priority);
        pendingAckTaskObj = null;
      }
    });

    socket.on('reportProgress', async (token, payload) => {
      // Ignore requests with invalid token.
      if (token !== syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted reportProgress with invalid token.`);
        return;
      }

      const progress = msgPack.decode(payload);
      winston.verbose(`Got progress from progress exchange, id: ${progress.taskId}`);

      if (progress.type === interface.ProgressReportType.Started) {
        progressPusher.createTask(progress.taskId);
        judgeStateCache.set(progress.taskId, {
          result: 'Compiling',
          score: 0,
          time: 0,
          memory: 0
        });
      } else if (progress.type === interface.ProgressReportType.Compiled) {
        progressPusher.updateCompileStatus(progress.taskId, progress.progress);
      } else if (progress.type === interface.ProgressReportType.Progress) {
        const convertedResult = judgeResult.convertResult(progress.taskId, progress.progress);
        judgeStateCache.set(progress.taskId, {
          result: getRunningTaskStatusString(progress.progress),
          score: convertedResult.score,
          time: convertedResult.time,
          memory: convertedResult.memory
        });
        progressPusher.updateProgress(progress.taskId, progress.progress);
      } else if (progress.type === interface.ProgressReportType.Finished) {
        progressPusher.updateResult(progress.taskId, progress.progress);
        setTimeout(() => {
          judgeStateCache.delete(progress.taskId);
        }, 5000);
      } else if (progress.type === interface.ProgressReportType.Reported) {
        progressPusher.cleanupProgress(progress.taskId);
      }
    });

    socket.on('reportResult', async (token, payload) => {
      // Ignore requests with invalid token.
      if (token !== syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted reportResult with invalid token.`);
        return;
      }

      const result = msgPack.decode(payload);
      winston.verbose('Received report for task ' + result.taskId);

      const judge_state = await JudgeState.findOne({
        where: {
          task_id: result.taskId
        }
      });

      if (result.type === interface.ProgressReportType.Finished) {
        const convertedResult = judgeResult.convertResult(result.taskId, result.progress);
        winston.verbose('Reporting report finished: ' + result.taskId);
        progressPusher.cleanupProgress(result.taskId);

        if (!judge_state) return;
        judge_state.score = convertedResult.score;
        judge_state.pending = false;
        judge_state.status = convertedResult.statusString;
        judge_state.total_time = convertedResult.time;
        judge_state.max_memory = convertedResult.memory;
        judge_state.result = convertedResult.result;
        await judge_state.save();
        await judge_state.updateRelatedInfo(false);
      } else if (result.type == interface.ProgressReportType.Compiled) {
        if (!judge_state) return;
        judge_state.compilation = result.progress;
        await judge_state.save();
      } else {
        winston.error('Unsupported result type: ' + result.type);
      }
    });
  });
}
module.exports.connect = connect;

class Callback {


  constructor(judge_state) {
    this.judge_state = judge_state
    this.flag = 0
  }
  async report(result) {
      try {
        if (this.flag === -1) return
        if(this.flag === 0) {
          if(result.account) {
            this.judge_state.vj_info = {...this.judge_state.vj_info, ...result}
          }
          this.flag = 1
          progressPusher.createTask(this.judge_state.task_id);
        }

        if(result.error) {
          this.flag = -1
          await remote_judge_fail(this.judge_state, result.error)
        } else {
            if(!result.status) return
            result.type = "remote"
            if(result.status !== 'Waiting' && this.flag === 1) {
              progressPusher.updateCompileStatus(this.judge_state.task_id, {
                status: (result.status === 'Compile Error') ? TaskStatus.Failed: TaskStatus.Done
              })
              this.flag = 2
            }
            if(result.is_over)  {
              this.flag = -1

              if(result.judge && result.judge.subtasks) {
                result.judge.subtasks.forEach(item => {
                  if(item.cases) {
                    item.cases.forEach(c => {
                      if(c.type) c.type = TestcaseResultType[c.type.replaceAll(" ", "")]
                    })
                  }
                })
              }

              this.judge_state.status = result.status
              this.judge_state.score = result.score
              this.judge_state.pending = false;
              this.judge_state.total_time = result.time
              this.judge_state.max_memory = result.memory
              this.judge_state.result = result
              await this.judge_state.save()

              progressPusher.updateResult(this.judge_state.task_id, this.judge_state.result)
              progressPusher.cleanupProgress(this.judge_state.task_id)
              await this.judge_state.updateRelatedInfo(false);
            } else if(this.flag === 2){
              progressPusher.updateProgress(this.judge_state.task_id, result)
            }

        }



      }catch (e) {}
  }
}

module.exports.judge = async function (judge_state, problem, priority) {
  let type, param, extraData = null;
  switch (problem.type) {
    case 'submit-answer':
      type = enums.ProblemType.AnswerSubmission;
      param = null;
      extraData = await fs.readFile(syzoj.model('file').resolvePath('answer', judge_state.code));
      break;
    case 'interaction':
      type = enums.ProblemType.Interaction;
      param = {
        language: judge_state.language,
        code: judge_state.code,
        timeLimit: problem.time_limit,
        memoryLimit: problem.memory_limit,
      }
      break;
    case syzoj.ProblemType.Remote:
      const info = syzoj.vjBasics.parseSource(problem.source)
      if(!syzoj.vjs[info.vjName]) {
        await remote_judge_fail(judge_state, "不存在 remote-oj : " + info.vjName)
        return
      }
      syzoj.provider.submit_code(info.vjName.toLowerCase(), info.problemId, judge_state.code, judge_state.language, new Callback(judge_state))
      // oj.submitCode(judge_state.code, info.problemId, syzoj.vjBasics.getLangId(info.vjName, judge_state.language), new Callback(oj, judge_state))

      return
    default:
      type = enums.ProblemType.Standard;
      param = {
        language: judge_state.language,
        code: judge_state.code,
        timeLimit: problem.time_limit,
        memoryLimit: problem.memory_limit,
        fileIOInput: problem.file_io ? problem.file_io_input_name : null,
        fileIOOutput: problem.file_io ? problem.file_io_output_name : null
      };
      break;
  }

  const content = {
    taskId: judge_state.task_id,
    judgeId: judge_state.id,
    testData: problem.id.toString(),
    type: type,
    priority: priority,
    realPriority: priority - parseInt(judge_state.id) / 10000000,
    param: param
  };

  judgeQueue.push({
    content: content,
    extraData: extraData
  }, content.realPriority);

  winston.warn(`Judge task ${content.taskId} enqueued.`);
}

const remote_judge_polling = async (judge_state, oj, submissionId) => {
  let k = 0
  let waitTime = 2000
  let vjInfo = ""
  let updateCompileStatus = false
  while(k < 50) {
    try {
      const result = await oj.getSubmissionStatus(submissionId)
      if(!result) throw -1
      if(!updateCompileStatus && result.status !== 'Waiting') {
        progressPusher.updateCompileStatus(judge_state.task_id, {
          status: (result.status === 'Compile Error') ? interface.TaskStatus.Failed: interface.TaskStatus.Done
        })
        updateCompileStatus = true
      }

      if(result.is_over) {
        judge_state.status = result.status
        judge_state.score = (result.status === 'Accepted') ? 100 : 0
        judge_state.pending = false;
        judge_state.total_time = result.time
        judge_state.max_memory = result.memory
        judge_state.result = result
        await judge_state.save()
        progressPusher.updateResult(judge_state.task_id, judge_state.result)
        progressPusher.cleanupProgress(judge_state.task_id)
        await judge_state.updateRelatedInfo(false);
        return
      } else {
        if (updateCompileStatus) {
          if(vjInfo !== result.info) {
            vjInfo = result.info
            progressPusher.updateProgress(judge_state.task_id, result)
            waitTime = 2000
          } else waitTime = Math.min(waitTime + 2000, 16000)
        }
      }
    } catch (e) {
      winston.warn(`remote-judge task error : ${e}`)
    }
    k++
    await syzoj.vjBasics.sleep(waitTime)
  }
  await remote_judge_fail(judge_state, "测评失败，请查看网络是否存在问题")
}

const remote_judge_fail = async (judge_state, error) => {
  judge_state.vj_info.error = error
  judge_state.status = 'Judgement Failed'
  judge_state.pending = false
  await judge_state.save()
  progressPusher.updateCompileStatus(judge_state.task_id, {
    status: interface.TaskStatus.Done
  })
  progressPusher.updateResult(judge_state.task_id, {
    type: syzoj.ProblemType.Remote,
    statusString: judge_state.status,
  })
  progressPusher.cleanupProgress(judge_state.task_id)
  await judge_state.updateRelatedInfo(false);
}



module.exports.getCachedJudgeState = taskId => judgeStateCache.get(taskId);


