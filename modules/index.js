let User = syzoj.model('user');
let Article = syzoj.model('article');
let Contest = syzoj.model('contest');
let Practice = syzoj.model('practice');
let Problem = syzoj.model('problem');
let Divine = syzoj.lib('divine');
let TimeAgo = require('javascript-time-ago');
let zh = require('../libs/timeago');
TimeAgo.locale(zh);
const timeAgo = new TimeAgo('zh-CN');

app.get('/', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let ranklist = await User.queryRange([1, syzoj.config.page.ranklist_index], { is_show: true, group_id: TypeORM.Not("0") }, {
      [syzoj.config.sorting.ranklist.field]: syzoj.config.sorting.ranklist.order
    });
    await ranklist.forEachAsync(async x => x.renderInformation());

    let notices = (await Article.find({
      where: { is_notice: true }, 
      order: { public_time: 'DESC' }
    })).map(article => ({
      title: article.title,
      url: syzoj.utils.makeUrl(['article', article.id]),
      date: syzoj.utils.formatDate(article.public_time, 'L')
    }));

    let fortune = null;
    if (res.locals.user) {
      fortune = Divine(res.locals.user.username, res.locals.user.sex);
    }

    let contests;
    if (!await res.locals.user.hasPrivilege(syzoj.PrivilegeType.ManageUser)) {
      let mycont = await res.locals.user.getconts();
      if (mycont.length === 0) {
          // 如果 mycont 数组为空，修改查询以包含特定的 group_id 条件
          contests = await Contest.queryRange([1, 5], { 
              is_public: true, 
              group_id: TypeORM.Like('%chk%') 
          }, {
              start_time: 'DESC'
          });
      } else {
          // 如果 mycont 数组非空，创建一个自定义查询，包括 mycont、is_public 和 group_id 条件
          let query = Contest.createQueryBuilder();
          query.where(`id IN (:...mycont)`, { mycont: mycont })
              .andWhere(`is_public = 1`)
              .orWhere(`group_id like '%chk%'`)
              .orderBy('start_time', 'DESC')
              .limit(5)
              .offset(0);
          contests = await query.getMany();
      }
    } else {
      // 如果用户具有 ManageUser 权限，执行原始查询
      contests = await Contest.queryRange([1, 5], { is_public: true }, {
          start_time: 'DESC'
      });
    }

  

    let practices = await Practice.queryRange([1, 5], { is_public: true }, {
      start_time: 'DESC'
    });

    let problems = (await Problem.queryRange([1, 5], { is_public: true }, {
      publicize_time: 'DESC'
    })).map(problem => ({
      id: problem.id,
      title: problem.title,
      time: timeAgo.format(new Date(problem.publicize_time)),
    }));

    res.render('index', {
      ranklist: ranklist,
      notices: notices,
      fortune: fortune,
      contests: contests,
      practices: practices,
      problems: problems,
      links: syzoj.config.links
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/help', async (req, res) => {
  try {
    res.render('help');
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});
