# OneBot 与 / 指令

## 使用方式

在草稿中输入 `/`，自动显示常用入口和中文操作说明。方向键选择，Tab 只补全；补全提示显示时按 Enter 确认候选，参数完整后执行指令。关闭补全提示后，Enter 和发送按钮均按普通消息发送，手动输入 `/help` 等命令文字不会执行指令。分类入口和子分类继续显示下一级候选，直到参数填写完整。提示关闭后，可按 Ctrl+Space 重新打开补全，再按 Enter 确认。

| 分类 | 示例 | 内容 |
| --- | --- | --- |
| 会话操作 | `/chat favorite`、`/chat mute`、`/chat history` | 收藏、免打扰、已读、收纳、好友备注、历史、跳转和会话搜索 |
| 个人资料 | `/profile info`、`/profile nickname 新昵称`、`/profile signature 新签名` | 当前登录账号的信息、昵称和签名 |
| 群资料 | `/group name 新群名`、`/group card @成员 新名片`、`/group title @成员 新头衔` | 群信息、群名、名片、头衔、群备注 |
| 群内容 | `/group notice list`、`/group notice publish 内容`、`/group files browse`、`/group essence list` | 公告、文件、精华、荣誉和签到 |
| 成员管理 | `/manage ban @成员 60`、`/manage kick @成员`、`/manage admin @成员` | 禁言、移出、管理员、成员查询、群申请、退出或解散 |

私聊隐藏群资料、群管理及对应子命令。个人资料修改始终作用于当前登录账号，确认框显示本人 QQ 号。昵称通过 `set_qq_profile` 只提交 `nickname`，不附带签名和性别字段；签名独立使用 `set_self_longnick`。接口参数参考 [NapCat SetQQProfile 源码](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/SetQQProfile.ts)。

禁言秒数省略时为 1800；文字参数支持引号。允许清空的字段必须显式填写 `""`，如 `/profile signature ""`、`/group card @成员 ""`。缺少参数、未知子命令、取消或服务端拒绝时保留修改类指令的草稿。已有回复标记保留；指令不作为普通聊天消息发送。

查询结果在本机只读编辑器中显示。`/help` 显示同一组常用入口；高级和服务端诊断接口不进入日常补全。

## 操作权限

| 操作 | 权限范围 |
| --- | --- |
| 撤回 | 私聊和普通群成员只能撤回本人消息；管理员还可撤回普通成员消息；群主还可撤回管理员消息 |
| 禁言、解除禁言、移出成员、修改他人名片 | 管理员只能操作普通成员；群主可操作管理员和普通成员 |
| 设置 / 取消管理员、专属头衔、解散群聊 | 群主 |
| 全员禁言、群名称、公告、精华、群文件夹、处理入群申请 | 群主或管理员；申请按所属群判断 |
| 修改本人名片、本人群备注、签到 | 无需管理权限 |
| 删除群文件 | 群主或管理员可删除群文件；普通成员仅可删除本人上传的文件 |
| 退出群聊 | 普通成员或管理员；群主需先转让群主，或选择解散 |
| 好友申请、本人收到的群邀请、个人资料 | 当前登录账号，无需群管理权限 |

成员和撤回候选按权限筛选，提交前重新向后端查询角色。权限无法确认时不采用旧的管理员缓存；取消、无权限或后端拒绝时保留指令草稿。消息操作只接受当前会话中已经发送且未撤回的消息；撤回时限和群内其他限制仍由后端判断。群文件上传者核对使用与文件浏览相同的目录读取范围。

## 快速表情与回复

- 输入半角 ! 或全角 ！，原生补全仅提供 `!表情` / `！表情` 入口。选择补全后才打开收藏表情面板，触发文字从草稿移除；方向键选图、Enter 插入占位符并自动关闭。手动输入或取消补全不会打开面板。
- 收藏表情元数据最多读取 500 项，缓存两分钟；选中项才获取图片。连接完成时预取列表，断线时仍可使用最近使用和 QQ 表情。/emoji 打开完整面板。
- 回复显示为草稿内的 [回复:群名片]。删除标记即可取消，撤销删除可恢复绑定；重新选择回复会替换原来的标记。悬浮可查看原文和图片，链接操作可取消。
- 回复标记绑定消息 ID；发送时剔除标记文字并生成真实 reply 段。回复、@、图片和普通正文可以混用。只写回复标记不能发送空消息。

## 指令清单

下表按用户入口和底层接口列出指令。日常操作通过补全候选或命令菜单执行；直接发送命令文字按聊天消息处理。底层接口不在常用补全中展示。涉及服务端数据的功能受当前 OneBot 服务端实现、QQ 状态和群权限约束。列表中的“修改”表示会改动 QQ 或后端数据；执行前展示目标和参数供确认。重连或账号切换会让尚未提交的旧操作失效；已提交但超时的修改不会自动重试。

| 指令 | 中文说明 | 可用会话 | 类型 |
| --- | --- | --- | --- |
| /emoji | 表情：收藏、最近使用和 QQ 表情 | 群聊 / 私聊 | 本地操作 |
| /image | 图片：选择图片并插入草稿占位符 | 群聊 / 私聊 | 本地操作 |
| /video | 视频：选择视频并插入草稿占位符 | 群聊 / 私聊 | 本地操作 |
| /file | 文件：选择文件并插入草稿占位符 | 群聊 / 私聊 | 本地操作 |
| /mention | 提及：选择群成员插入真实 @ | 群聊 | 本地操作 |
| /reply | 回复：选择当前会话中的消息 | 群聊 / 私聊 | 本地操作 |
| /cancel_reply | 取消当前草稿的回复 | 群聊 / 私聊 | 本地操作 |
| /chat history | 加载更多聊天记录 | 群聊 / 私聊 | 本地操作 |
| /chat latest | 跳到最新消息和草稿区 | 群聊 / 私聊 | 本地操作 |
| /chat search | 搜索并打开会话 | 群聊 / 私聊 | 本地操作 |
| /chat favorite | 收藏或取消收藏当前会话 | 群聊 / 私聊 | 本地操作 |
| /chat archive | 放入或移出收纳箱 | 群聊 | 本地操作 |
| /chat read | 将当前会话标记为已读 | 群聊 / 私聊 | 本地操作 |
| /chat mute | 切换本机会话提醒 | 群聊 / 私聊 | 本地操作 |
| /settings | 打开连接与聊天设置 | 群聊 / 私聊 | 本地操作 |
| /style | 选择聊天记录的代码风格 | 群聊 / 私聊 | 本地操作 |
| /refresh | 刷新好友和群聊列表 | 群聊 / 私聊 | 本地操作 |
| /help | 查看常用指令菜单 | 群聊 / 私聊 | 本地操作 |
| /chat | 会话操作 | 群聊 / 私聊 | 分类 |
| /profile | 个人资料 | 群聊 / 私聊 | 分类 |
| /group | 群资料 | 群聊 | 分类 |
| /manage | 成员管理 | 群聊 | 分类 |
| /profile nickname | 修改当前账号昵称 | 群聊 / 私聊 | 修改 |
| /recall | 撤回所选消息 | 群聊 / 私聊 | 修改 |
| /message | 查看消息详情 | 群聊 / 私聊 | 查询 |
| /forward_info | 查看合并转发内容 | 群聊 / 私聊 | 查询 |
| /forward | 选择消息，再选择逐条或合并转发 | 群聊 / 私聊 | 修改 |
| /like | 给好友资料点赞 | 群聊 / 私聊 | 修改 |
| /poke | 戳一戳当前好友或群成员 | 群聊 / 私聊 | 修改 |
| /profile info | 查看当前登录账号 | 群聊 / 私聊 | 查询 |
| /user | 查看 QQ 用户资料 | 群聊 / 私聊 | 查询 |
| /friends | 查看好友列表 | 群聊 / 私聊 | 查询 |
| /groups | 查看群聊列表 | 群聊 / 私聊 | 查询 |
| /group info | 查看当前群资料 | 群聊 | 查询 |
| /manage member | 查看群成员资料 | 群聊 | 查询 |
| /manage members | 查看当前群成员列表 | 群聊 | 查询 |
| /group honors | 查看群荣誉 | 群聊 | 查询 |
| /status | 查看 OneBot 运行状态 | 群聊 / 私聊 | 查询 |
| /version | 查看 OneBot 服务端和协议版本 | 群聊 / 私聊 | 查询 |
| /can_image | 检查图片发送能力 | 群聊 / 私聊 | 查询 |
| /can_voice | 检查语音发送能力 | 群聊 / 私聊 | 查询 |
| /image_info | 获取图片文件信息 | 群聊 / 私聊 | 查询 |
| /record_info | 获取语音文件信息 | 群聊 / 私聊 | 查询 |
| /manage ban | 禁言群成员 | 群聊 | 修改 |
| /manage unban | 解除成员禁言 | 群聊 | 修改 |
| /manage ban_all | 开启全员禁言 | 群聊 | 修改 |
| /manage unban_all | 关闭全员禁言 | 群聊 | 修改 |
| /manage kick | 将成员移出群聊 | 群聊 | 修改 |
| /manage admin | 设置群管理员 | 群聊 | 修改 |
| /manage unadmin | 取消群管理员 | 群聊 | 修改 |
| /group card | 修改群名片（留空恢复默认） | 群聊 | 修改 |
| /group title | 修改成员专属头衔（留空清除） | 群聊 | 修改 |
| /group name | 修改群名称 | 群聊 | 修改 |
| /manage leave | 退出当前群聊 | 群聊 | 修改 |
| /manage dismiss | 解散当前群聊（仅群主） | 群聊 | 修改 |
| /chat requests | 处理本次连接收到的好友、入群申请和邀请 | 群聊 / 私聊 | 修改 |
| /manage requests | 查看服务端群申请和邀请 | 群聊 / 私聊 | 查询 |
| /group notice list | 查看群公告 | 群聊 | 查询 |
| /group notice publish | 发布群公告 | 群聊 | 修改 |
| /group notice delete | 删除群公告 | 群聊 | 修改 |
| /group essence list | 查看群精华消息 | 群聊 | 查询 |
| /group essence add | 将消息设为群精华 | 群聊 | 修改 |
| /group essence remove | 移除群精华消息 | 群聊 | 修改 |
| /group files browse | 浏览群文件和文件夹、下载文件 | 群聊 | 查询 |
| /group files space | 查看群文件空间用量 | 群聊 | 查询 |
| /group files folder | 新建群文件夹 | 群聊 | 修改 |
| /group files folder_delete | 删除群文件夹及其中内容 | 群聊 | 修改 |
| /group files delete | 删除群文件 | 群聊 | 修改 |
| /react | 给消息添加表情回应 | 群聊 / 私聊 | 修改 |
| /unreact | 取消消息表情回应 | 群聊 / 私聊 | 修改 |
| /chat remark | 修改当前好友备注 | 私聊 | 修改 |
| /group remark | 修改本机 QQ 群备注 | 群聊 | 修改 |
| /profile signature | 修改 QQ 个性签名 | 群聊 / 私聊 | 修改 |
| /online_clients | 查看在线客户端 | 群聊 / 私聊 | 查询 |
| /friend_categories | 查看好友分组 | 群聊 / 私聊 | 查询 |
| /recent_contacts | 查看最近会话 | 群聊 / 私聊 | 查询 |
| /manage at_all | 查看 @全体成员剩余次数 | 群聊 | 查询 |
| /manage bans | 查看群禁言成员 | 群聊 | 查询 |
| /group sign | 群签到 | 群聊 | 修改 |
| /cookies | 查看指定域名的 QQ Cookies（敏感） | 群聊 / 私聊 | 查询 |
| /csrf | 查看 QQ CSRF Token（敏感） | 群聊 / 私聊 | 查询 |
| /credentials | 查看指定域名的 QQ 凭证（敏感） | 群聊 / 私聊 | 查询 |
| /restart | 重启 OneBot 后端，连接将中断 | 群聊 / 私聊 | 修改 |
| /backend_cache | 清理 OneBot 服务端和 QQ 的图片、语音、视频与文件缓存 | 群聊 / 私聊 | 修改 |

## OneBot v11 公开 API 对照

基于 [OneBot v11 公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md) 和 [NapCat 当前接口注册](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/index.ts) 核对。相同功能复用已有入口，避免重复的发送命令。

| OneBot API | 插件入口 |
| --- | --- |
| send_private_msg / send_group_msg / send_msg | 草稿 Enter 发送，通过 send_msg 按会话类型处理；/image、/file、/emoji、/mention 准备内容 |
| delete_msg / get_msg / get_forward_msg | /recall、/message、/forward_info |
| send_like | /like |
| set_qq_profile / set_self_longnick（扩展） | /profile nickname、/profile signature |
| set_group_kick / set_group_ban / set_group_whole_ban | /manage kick、/manage ban、/manage unban、/manage ban_all、/manage unban_all |
| set_group_admin / set_group_card / set_group_name / set_group_leave / set_group_special_title | /manage admin、/manage unadmin、/group card、/group name、/manage leave、/manage dismiss、/group title |
| set_friend_add_request / set_group_add_request | /chat requests 按原始 flag 处理好友申请、入群申请和群邀请 |
| get_login_info / get_stranger_info / get_friend_list / get_group_list | /profile info、/user、/friends、/groups |
| get_group_info / get_group_member_info / get_group_member_list / get_group_honor_info | /group info、/manage member、/manage members、/group honors |
| get_image / get_record / can_send_image / can_send_record | /image_info、/record_info、/can_image、/can_voice；聊天图片预览也使用 get_image |
| get_cookies / get_csrf_token / get_credentials | /cookies、/csrf、/credentials |
| get_status / get_version_info / set_restart / clean_cache | /status、/version、/restart、/backend_cache |
| set_group_anonymous / set_group_anonymous_ban | 当前 NapCat 注册表没有启用，不提供无效入口 |

## 已接入的扩展能力（如 NapCat 等）

- 消息：单条转发、表情回应、戳一戳。
- 群聊：公告、精华、签到、@全体剩余次数、禁言列表、群备注。
- 文件：群文件空间、根目录与子目录浏览、下载、新建 / 删除文件夹、删除群文件。已有 /file 通过流式上传处理群 / 私聊文件。
- 联系人：好友备注、个性签名、好友分类、最近联系人、在线客户端。
- 表情：收藏表情、最近使用、QQ 表情，以及 ! / ！快捷补全。

## 兼容与范围

- /chat requests 仅收集当前插件连接期间收到的申请事件，按账号隔离、最多保留 100 条，不写入磁盘；/manage requests 可另外查询服务端群系统消息。已在其他客户端处理或过期的申请可能被后端拒绝，成功后才从本地移除。
- /group files browse 当前每个目录读取前 200 个条目；下载使用本机保存对话框和临时文件，取消或失败不会覆盖目标文件。/group files folder_delete 会删除指定文件夹及其内容，确认时应核对对象。
- Cookies、CSRF 和凭证属于高级入口，仅在临时只读文档中显示；不自动复制或记录到输出日志，关闭文档、断线或切换账号后清除对应结果。后端权限和支持程度由实际返回决定。
- /backend_cache 清理的是 OneBot 服务端 / QQ 缓存，包含图片、语音、视频和文件，与插件自身的附件缓存清理不同。/restart 会中断后端连接。
- 语音、视频等在聊天正文中仍为文字占位；/record_info 获取文件信息，未实现录音、视频播放或全部消息段的发送 UI。合并转发支持只读代码风格阅读、图片预览、嵌套展开；/forward 统一选择消息后决定逐条或合并转发，均保持原顺序，不提供伪造发送者或自定义节点内容。
- 服务端的高级扩展（如相册、AI 语音、空间等）尚未提供专用入口。没有添加任意 JSON / 原始数据包执行器；后续功能沿同一指令目录扩展。

接口参考：[OneBot v11](https://github.com/botuniverse/onebot-11)、[NapCat API 一览](https://napneko.github.io/onebot/api)、[NapCat 接口和参数源码](https://github.com/NapNeko/NapCatQQ/tree/main/packages/napcat-onebot/action)。
