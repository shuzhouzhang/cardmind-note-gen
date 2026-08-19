# 自托管同步手工验收矩阵

本矩阵不新增客户端测试文件。每轮协议冻结后先运行 `pnpm sync:self-hosted-schema` 刷新 OpenAPI 类型，再分别在桌面、iOS 和 Android 的实验开关下验收。

| 领域 | 桌面 | iOS | Android | 验收重点 |
|---|---|---|---|---|
| 连接与登录 | 待验收 | 待验收 | 待验收 | 浏览器授权、密码/TOTP 备用登录、HTTP 持续警告、HTTPS 不降级、实例替换阻断 |
| 个人数据 | 待验收 | 待验收 | 待验收 | tag、mark、conversation、message、memory、settings；领域开关；秘密与本地路径不传播 |
| 资料库 | 待验收 | 待验收 | 待验收 | 新建、绑定已有、暂不同步、多目录并存、首次固定快照合并、同路径冲突副本 |
| Blob | 待验收 | 待验收 | 待验收 | 分片续传、complete 幂等、下载哈希、加密附件、各阶段强退恢复 |
| Markdown | 待验收 | 待验收 | 待验收 | 两账号多设备同时编辑、重复/乱序 update、离线重连、源码模式三方合并、checkpoint 清理 |
| Canvas | 待验收 | 待验收 | 待验收 | 节点/边并发、拖拽 presence、拖拽结束持久化、本机撤销、普通 JSON 物化 |
| 权限 | 待验收 | 待验收 | 待验收 | capability 组合、Viewer 拒写与转存、邀请接受/撤销、成员移除后停同步且保留本地目录 |
| 引擎切换 | 待验收 | 待验收 | 待验收 | 切换前暂停并检查差异；Git/S3/WebDAV/Cloud Folder 行为不回归；任何远端均不自动删除 |

## 强退恢复点

逐项在写入前后强制结束应用并重新打开：SQLite 业务事务、outbox command 固化、Push 响应、inbox 应用、ACK、Blob 每个分片、Blob complete、文件 journal 临时文件写入与原子替换。

## 多端协作场景

使用两个账号、至少三台设备。验证同时编辑、离线修改、乱序与重复唤醒、网络恢复、前后台切换、成员被移除、sync epoch 变化，以及共享资料库在每台设备选择不同本地落地目录。应用挂起期间允许不实时，但回到前台必须立即补齐 durable outbox 与 cursor。
