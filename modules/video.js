let Problem = syzoj.model('problem');
let UserPrivilege = syzoj.model('user_privilege');
let Video = syzoj.model("video")

const { v4: uuidv4 } = require('uuid');

let { exec } = require('child_process')
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs-extra');

app.get('/videos', async (req, res) => {
  try {
    if (!res.locals.user || !await res.locals.user.hasPrivilege(syzoj.PrivilegeType.AddVideo)) throw new ErrorMessage('您没有权限进行此操作。');

    let query = Video.createQueryBuilder();

    if (!res.locals.user.is_admin) {
      query = query.where('Video.user_id = :userId', { userId: res.locals.user.id });
    }

    let paginate = syzoj.utils.paginate(await Video.countForPagination(query), req.query.page, syzoj.config.page.video);
    let videos = await Video.queryPage(paginate, query, {
      created_time: 'DESC'
    });

    res.render('videos', { videos, paginate})
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    })
  }
});

app.post('/video/upload', app.multer.single('video'), async (req, res) => {
  try {
    if (!res.locals.user || !await res.locals.user.hasPrivilege(syzoj.PrivilegeType.AddVideo)) throw new ErrorMessage('您没有权限进行此操作。');

    const timestamp = syzoj.utils.getCurrentDate();
    const tempPath = req.file.path;
    const targetPath = path.join('uploads/videos', `${res.locals.user.username}_${timestamp}`);
    const outputPath = `${targetPath}/index.m3u8`;

    const videoSize = req.file.size;

    await fs.move(tempPath, `${targetPath}.mp4`);
    await fs.ensureDir(targetPath);
    await execAsync(`ffmpeg -i ${targetPath}.mp4 -c:v libx264 -c:a aac -start_number 0 -hls_time 10 -hls_list_size 0 -f hls ${outputPath}`);
    await fs.remove(`${targetPath}.mp4`);

    const video = new Video();
    video.title = req.body.title;
    video.description = req.body.description;
    video.problem_id = req.body.problem_id || null;
    video.url = targetPath;
    video.access_url = uuidv4();
    video.user_id = res.locals.user.id;
    video.size = videoSize;
    video.created_time = syzoj.utils.getCurrentDate();

    await video.save();
    res.redirect(syzoj.utils.makeUrl(['videos']));

  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.post('/video/delete/:id', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    const video = await Video.findOne({ id: req.params.id });
    if (!video) {
      throw new ErrorMessage('视频不存在。');
    }
    if (video.user_id != res.locals.user.id && !res.locals.user.is_admin)
      throw new ErrorMessage('您没有权限进行此操作。');

    const filePath = path.join('uploads/videos', video.url);
    await fs.remove(filePath);

    await Video.remove(video);

    res.redirect(syzoj.utils.makeUrl(['videos']));
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});


app.get('/video/:accessUrl', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    const video = await Video.findOne({ access_url: req.params.accessUrl });

    if (!video) {
      throw new ErrorMessage('视频未找到。');
    }
    video.url = `/streams/${path.basename(video.url)}/index.m3u8`;

    res.render('video', { video, main_style: 'width: 80%;'});
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
