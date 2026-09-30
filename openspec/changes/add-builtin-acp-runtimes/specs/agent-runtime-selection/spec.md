## MODIFIED Requirements

### Requirement: Manage configured ACP providers in model settings

CodeZ SHALL 在现有供应商添加流程中选择 ACP 后直接展示自定义 ACP 配置表单，无需再次选择自定义卡片；表单的标题、返回和布局与 API 供应商添加页一致。同一添加页 SHALL 提供「内置 Runtime」分段，用于新增 Claude Code、Codex 或 Pi 的内置配置（Runtime、稳定 ID、显示名与认证/Provider 设置）；它不是独立的 Runtime 选择器，保存后配置出现在同一 ACP 供应商列表。已配置的 ACP 供应商 SHALL 可修改显示名称、绝对命令路径和字符串参数数组，稳定 ID SHALL 不可修改；内置配置 SHALL 在其 ACP 详情中修改显示名称、认证方式与 Provider 设置。保存失败 SHALL 保留编辑草稿并显示错误。

#### Scenario: Add a custom ACP provider

- **WHEN** 用户在添加供应商页选择 ACP 并提交合法配置
- **THEN** 直接进入配置表单，新供应商出现在现有供应商列表，表单与返回入口沿用同页 API 添加流程的样式

#### Scenario: Add a built-in runtime configuration

- **WHEN** 用户在 ACP 添加页切换到「内置 Runtime」，选择 Runtime 并提交合法 ID、名称与认证设置
- **THEN** 新配置出现在现有供应商列表并打开其详情；ID 已被占用时保留草稿并显示错误

#### Scenario: Edit a configured ACP provider

- **WHEN** 用户修改已有自定义 ACP 供应商的名称、命令或参数并保存
- **THEN** Host 只更新该稳定 ID 对应的配置；命令或参数改变时旧模型缓存不用于新进程身份，旧会话仍按原身份校验

#### Scenario: Invalid edit

- **WHEN** 新命令不可执行、参数无效或配置文件无法安全更新
- **THEN** 原配置保持不变，设置页保留草稿并展示失败原因
