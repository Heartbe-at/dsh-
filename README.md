# DSH 会话删除插件

在 DSH 左侧会话列表里**右键会话 → 删除会话…**，确认后：

1. 会话立即从主列表隐藏（归档），当前会话会自动退出到空白/新会话界面；
2. 会话 ID 写入待删除队列；
3. **下次启动 DSH 时**自动删除会话目录、投影缓存和工作区/归档引用。

运行中的 DSH 可能仍持有会话日志和索引，所以插件不会在当前进程里删除文件。

## 使用

1. 右键任意**已存在**的会话行（空白“新会话”行没有菜单）。
2. 选择 `删除会话…`。
3. 阅读说明后点 `隐藏并稍后删除`。
4. 重启 DSH，完成真正的文件清理。

如果暂时不想重启：会话已经从主列表隐藏，可在“已归档”里看到；下次启动 DSH 时会删除。重启前想反悔，可在 DSH 停止后删除队列条目：

```
E:\Program Deepseek\session-delete\pending.json
```

当前队列里留有一条测试会话 `session-0295fa00-8122-4a63-9dc2-eaca6e094436`（标题 `OK 简短回复测试`），下次启动会被自动清掉。

## 清理范围

- 会话日志目录：`<DSH_HOME>/sessions/<workspace>/<session-id>/`
- 投影缓存：`<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json`
- 工作区里的会话引用
- 工作区的归档 ID

附件是全局去重存储，可能被其他会话引用，因此**不会删除**。

## 安全边界

- 只在**新进程启动后的前 10 分钟**、且本次进程第一次加载插件时扫描队列一次。
- 本次运行中新建的队列条目（`queuedAt` 不早于进程启动时间）不会被当前进程删除。
- 删除前校验会话目录名必须等于会话 ID，避免误删其他目录。
- 队列写入使用临时文件 + 重命名，损坏的队列会改名为 `pending.json.corrupt-<时间戳>`，不会静默覆盖。

## 文件结构

```
plugin/
  index.js            Host 插件：删除队列、启动清理、POST /api/session-delete/request
  client.js           浏览器插件：右键菜单、确认弹窗
  package.json        bundle + client 清单
  cordis.patch.yml    插件插入行
  locale/zh.json      中文文案 / 插件市场元数据
  locale/en.json      英文文案
  docs/DETAIL.md      实现与清理语义说明
  icon.svg            插件图标
```

插件已安装到桌面版 profile（bundle 名 `dsh-session-delete`，source 指向本目录的 `plugin`）。修改源码后需要重新执行 `plugin_manager install_bundle`，并重启 DSH 让 Host 侧新代码生效。
