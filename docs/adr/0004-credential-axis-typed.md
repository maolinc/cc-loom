# 凭据定型分发轴：一凭据一轴

ADR-0003 把 env 与 path 两类鉴权统一到同一张 `credentials` 值存储 + `credential_distributions` 分发表，轴（axis）只记录在分发记录上，单个凭据可同时被「下发设备」（env）和「分发项目」（path）。实际使用中，设置页对每条凭据都并列展示两个分发按钮，语义模糊、易误操作（用户不清楚某个 token 该走哪条路），且 env 与 path 的分发维度本就互斥：env 是设备维度、path 是项目维度。

本 ADR 在 ADR-0003 的统一存储之上叠加一条约束：**凭据创建时即定型 `axis`，且创建后不可变**。

## 关键决策

1. **`credentials.axis` 列（TEXT NOT NULL，`env` | `path`）。** 创建时由用户显式选择，落库后不可变（更新接口不接受 `axis` 字段）。值与 `constants.CREDENTIAL_AXES` 对齐。

2. **禁止跨轴分发。** `POST /credentials/:id/distribute` 校验请求 `axis` 必须等于凭据自身 `axis`，否则 400：
   - `axis=env` 凭据 → 只可下发到设备（targetId = 设备 id），无项目维度分发。
   - `axis=path` 凭据 → 只可分发到项目（targetId = 项目 id），无设备维度分发。
   设置页每条凭据只展示其所属轴对应的下发按钮。

3. **列表分组展示。** 设置页凭据列表按 `axis` 拆成「环境变量凭据」「MCP 路径凭据」两段，每段独立计数与说明，创建弹层顶部用分段选择器选型。

4. **老库回填。** 迁移给 `credentials` 加 `axis` 列（默认 `'env'`），再按现有数据回填：凭据若有 `credential_distributions` 中 `axis='path'` 的记录，或被 `credential_usages`（仅记录 path 绑定声明侧使用）引用 → 回填 `'path'`；否则 `'env'`。`credential_usages` 仅由 path 绑定产生，故其存在即可判定 path。

5. **`credentialName` 仍为 env/path 共用链接键。** 不改变 ADR-0003 的统一存储与链接键语义。若同一逻辑 token 既需要走 env 又需要走 path 注入，用户须用不同凭据名建两条凭据（各属一轴）。这是「一凭据一轴」的直接代价，换取分发语义清晰、UI 不再并列两个按钮。

6. **`AssetAuthBinding.kind` 不变。** 资产侧声明的 `kind: env|path` 仍由资产作者决定，与本 ADR 的凭据侧 `axis` 是两个独立维度：声明描述「这个凭据被怎样消费」，凭据 `axis` 描述「这个值走哪条分发通道」。两者的 `credentialName` 一致即建立链接；若资产声明的 `kind` 与用户所建凭据的 `axis` 不一致（如资产声明 env 绑定、用户却建了同名的 path 凭据），值不会落地——这是用户配置错误，由设置页「被用到哪里」展示与「待配置」提示承担可发现性。

## 后果

- `credentials` 表新增 `axis` 列；`credential_distributions.axis` 保留不变（仍记录每条分发的轴，与凭据 `axis` 一致）。
- 设置页创建弹层增加类型选择；列表分两组；每行只一个分发按钮。
- `POST /credentials` 必须带 `axis`；`POST /credentials/:id/distribute` 增加跨轴校验。
- testkit `createCredential(name, value, axis, description?)` 第三个参数为 axis，默认 `'env'`。
