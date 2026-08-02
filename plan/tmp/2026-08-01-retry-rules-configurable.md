# 正交场景设计:可配置重试规则(HTTP 状态码 + body code 组合)

## 任务背景

把写死的"503+10310"重试规则提成可配置组合规则,并修复 retryOnStatus 被流式提前吞掉的 bug。

## 规则模型

```
retryRules: [{ status, code }]
- status: number(100..599) | '*'(任意状态码通配)
- code:   number | 'all'(任意 body code 通配)
```

匹配语义:响应 HTTP status 匹配规则 status(`*` 通配任意),且 body 满足规则 code 要求。
- `code === 'all'`:不依赖 body,响应头一到即决断重试(因为成功是 2xx,不会配成 all 规则)。
- `code === 具体数字`:需 parse 出 `{type:'error', error:{code}}` 且 code 匹配。
- `status === '*'`:任意状态码都匹配该规则(兼容旧 retryOnBodyErrorCode 的"任意状态+该 code")。

默认规则(等价原写死行为):
```
[{status:503, code:10310}, {status:200, code:10310}]
```

## 正交维度

### D1: 规则 status 维度
- D1a 具体状态码(如 429、503、200)
- D1b `*` 通配(任意状态码)
- D1c 状态码不在任何规则里(不重试,透传)

### D2: 规则 code 维度
- D2a 具体数字(如 11210、10310)
- D2b `all` 通配(任意 body code,响应头即决断)
- D2c body code 不匹配任何规则(不重试)

### D3: body 形态维度(影响具体 code 规则的判定)
- D3a body 是合法 JSON `{type:'error', error:{code:N}}`(可判 code)
- D3b body 是合法 JSON 但非 error 结构(成功响应/其他结构)→ not-error
- D3c body 不是合法 JSON(成功 SSE 首 chunk `event:..\ndata:..`)→ incomplete,继续攒
- D3d body 为空(空 body 的非 2xx)
- D3e body error JSON 被切片(首段 parse 失败,需攒到上限)

### D4: 决断时机维度(核心 bug 修复点)
- D4a `all` 规则:响应头到达即决断(不等 body)→ 必须在 writeHead 之前
- D4b 具体 code 规则:首段 body parse 成功即决断
- D4c 攒到 FIRST_BODY_INSPECT_LIMIT 仍 parse 不出 → 当成功转发(不误判)
- D4d 上游 end 仍 pending(空 body)→ 当成功转发

### D5: 重试预算维度
- D5a 首次成功(success-direct)
- D5a 重试后成功(success-after-retry)
- D5b 重试预算耗尽仍失败(failed,末次响应透传)
- D5c 单条规则命中但 maxAttempts=1(不重试,直接透传)

### D6: 模式维度
- D6a 拦截重试模式(passthrough=false)→ 规则生效
- D6b 透传模式(passthrough=true)→ 不判规则,原样转发

### D7: 配置层维度(config-store)
- D7a 默认规则(无 config 字段时 fallback 到默认)
- D7b 热更新规则(POST /api/config 即生效)
- D7c 校验:非法 status(非数字/越界)、非法 code、非法结构 → 400
- D7d 向后兼容:老 config.json 含 retryOnStatus/retryOnBodyErrorCode → 迁移成 retryRules
  - 旧 retryOnStatus:[503] → {status:503, code:'all'}
  - 旧 retryOnBodyErrorCode:[10310] → {status:'*', code:10310}
- D7e 持久化:retryRules 写回 config.json
- D7f getView 返回 retryRules 给前端

### D8: trace 维度
- D8a configSnapshot 含 retryRules
- D8b attempt.reason 带命中规则描述(如 "rule 429+11210")
- D8c 启动日志打印 retryRules

### D9: 网络错误维度(不变,回归)
- D9a status=0(超时/断连)→ 不重试,合成 502(原行为)

## 高风险边界(必须有 case)

1. **状态转换**:all 规则命中→buffer→重试;具体 code 命中→buffer→重试;不命中→stream→透传
2. **异常路径**:body parse 失败、body 为空、规则配置非法、上游无响应
3. **时序**:all 规则必须在 writeHead 前决断(否则 429/503 被流走=原 bug);具体 code 规则首段即决断
4. **空/初始**:空规则表(不重试任何)、默认规则
5. **幂等**:同一条规则重复配、多条规则同时命中同一响应
6. **边界**:maxAttempts=1、FIRST_BODY_INSPECT_LIMIT 边界、status 通配 `*` + code `all` 同时存在

## 用例挑选(按维度覆盖,非按数量)

详见 Step 3 实现的测试文件。每个用例覆盖一个独立路径,不重复同一逻辑路径。
