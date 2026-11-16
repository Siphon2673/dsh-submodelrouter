# dsh-submodelrouter

为 DSH 子代理委派提供两档 effort。主 agent 只需选择 `effort: normal | high`，
不必再填写裸 provider、model 和 reasoning effort；由你配置每一档使用哪条路由。

这是一个标准双端 DSH bundle：Host 适配器为原生 `subagent` 工具加遮罩，Web 端提供
自己的 Configure 页面。它不修改原生 DSH 包、原生 Subagent 设置页、preset 或主输入框
的模型选择器；它只读取原生 Subagent 授权，不会修改授权。

## 模型看到什么

- `subagent` 保留原生委派参数（`description`、`prompt`、`cwd`，原生存在时还有
  `agent_preset`），移除 `provider`、`model`、`reasoning_effort`。
- 新增可选 `effort`，只接受 `normal` 或 `high`；其他值在原生执行前被参数校验拒绝。
- `normal` 用于常规、可检查或容易重做的工作；`high` 用于结果会被直接信任或错误代价
  高昂的工作。它表达“花多少能力”，不是任务类型或难度分数。
- 省略 `effort` 时以不含路由字段的方式调用原生委派，完全继承父路由。
- `list_subagent_models` 被替换为只含档位信息的发现工具：档位含义、是否已配置、
  省略语义和修复指引；不返回裸路由，也不保证旧 Session 已授权某条路由。
- 遮罩生效期间恢复原生通用委派/深度提示；不增加额外的选档提醒；`subagent_fork`、
  workflow 子代理和外部子代理提供方不受影响。

## Parent fallback

配置的档位只有在原生委派接受时才会使用。以下情况会执行一次父路由委派并显示警告：

- 该档位未配置；
- 原生 Session 授权拒绝所选路由（包含有 recorded policy 与旧 Session 无 policy 的
  两种完整消息形式）；
- 评审过的 adapter 返回不支持 reasoning effort、未注册 provider 或未知模型
  （包括 typed `NO_ADAPTER`）。

父路由调用只执行一次，且位于所选调用的 catch/重试路径之外。取消、深度/容量限制、
provider generation 变化、启动/admission/catalog 失败、输出失败、参数错误和未知错误
都会原样抛出，不触发回退。回退自身失败会原样传播，插件不会创建第二个子代理。显式
档位结果包含 `(effort: normal|high)`；回退结果包含警告、原生 child id 和父继承说明。
规范结果值仍是原生 `{ kind: 'activation', subagentId }`。

对任意启动错误无法证明“没有创建 child”，因此回退只覆盖上述评审过的 pre-creation
失败。极少数 LLM adapter 瞬时缺失时，接受结果是一个带警告的父路由 child，绝不重复
创建 child。

## 配置

通过标准插件流程安装，然后在 **Plugins** 中启用对应行：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-submodelrouter
```

发布后可改用 registry spec。运行中的 Plugin Manager 也提供相同的安装与行开关。

需要配置两个页面：

1. **Plugins → Subagent → Model selection**：启用原生授权并加入允许的路由。
2. **Plugins → Submodel router → Configure**：为 Normal 和 High 选择 provider、
   model 和可选 reasoning effort。页面只提供当前已授权的路由。

原生 Subagent 授权在 Session 启动时采样；修改后请启动新 Session。档位映射修改对下一次
委派生效（包括已存在的 Session）；旧 Session 未授权的路由会走 Parent fallback。已经
创建的子代理保持启动时的路由。

两档共用插件自己的一个 Save。离开页面会丢弃未保存草稿；revision 过期会报告冲突而不是
覆盖较新的值；插件从不写入原生授权命名空间。已保存但后来未授权、不可用或 effort 不再
受支持的值仍会显示并标记，可继续修复。

## 停用与卸载

停用该行或 bundle 会移除遮罩、发现工具替换、插件提示、监听器和 Configure 页面；原生
`subagent` 工具和提示按原生机制恢复。重新启用不会产生重复注册。卸载会把已保存配置留在
profile 中，重装同一 row id 可恢复；插件不会删除配置或 Session。

安装期间创建的父子 Session 只使用原生执行与核心 Session 记录，所以卸载后历史仍可恢复。
若环境不支持运行中 profile 重组，安装、卸载或启停后请重启 profile。

## 范围与支持边界

- v1 只支持 shipped standard Web preset 的本地 in-process `spawn` `subagent` 行；
  使用同名工具的外部 provider 行不在范围内。
- 若依赖“省略 `effort` = 父路由”的保证，`subagent` 行不能配置固定 child
  `agentOptions` 或 provider 路由默认值。标准 preset 没有这些默认值；自定义 profile
  覆盖不在 v1 保证内，回退文案只描述标准 preset。
- reasoning effort 是原生模型能力，不是档位。编辑器只列出所选模型声明的 efforts，
  “Default / native inheritance”对应不存储该字段；切换路由会重置 effort。

## DSH 兼容性

| DSH 版本 | 验证状态 |
| --- | --- |
| `0.2.2-rc.1` | 已测试 |

manifest 不声明 `engines.dsh`，也不固定 DSH peer 版本，因此未验证的 DSH 版本不会仅因
“未验证”被拒绝。包会把它实际导入的 Host 运行时模块声明为 `*` peer，并在
`devDependencies` 中固定同一版本以便构建/测试可复现。`*` 表示有意不设版本门禁，不代表
所有版本都经过测试：在其他 DSH 版本上，可用服务与 API 形状可能不同，应根据实际失败诊断。
正常安装路径不需要 version exemption。除非完整矩阵已在某个版本通过，否则不要向表中新增行。

## 开发

Host 适配器是普通 ESM JavaScript；浏览器端是手写的 lazy-CJS 模块工厂，本地安装无需构建。

```sh
npm install
npm run typecheck
npm test
```

浏览器端到端套件需要 Playwright 的 Chromium，因此默认按需运行：

```sh
npx playwright install --with-deps chromium
DSH_E2E=1 npm run test:e2e
```

它会在 `.scratch/e2e-runs` 下创建一次性 `DSH_HOME` 和 Web profile，只把脱敏证据
留在 `.scratch/submodelrouter/e2e-evidence`，并在成功或失败后删除临时根目录。

测试使用真实 DSH 工具运行时、脚本化 LLM adapter、生产 AgentLoop 和真实 Session。
端到端套件会创建一次性 `DSH_HOME` 和 Web profile，安装 bundle，走真实 Configure 页面
和生命周期，并在成功或失败后删除临时根目录；不会使用或修改当前 DSH home/profile。
