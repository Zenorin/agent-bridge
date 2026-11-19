# agent-bridge

Claude Code·Codex·Gemini 세 수신자가 작업·결과·질문을 주고받는 로컬 작업함이다. SQLite에 메시지와 상태를 기록하고, Codex 작업은 `codex app-server`로, Claude 일반 업무와 읽기 전용 독립 검수는 `claude -p`로, Gemini 작업은 Antigravity CLI로 실행하며, 연결 방식(Gemini API 키 또는 개인 Google 계정)은 사용자가 설정에서 고른다. 브리지의 큐·조회 기능 자체는 모델을 호출하지 않는다.


## 요구 사항

- Node 22.5 이상 (`node:sqlite` 사용, 추가 의존성 없음)
- Codex 실행기: `codex` CLI 설치와 로그인 (확인 버전 0.163.0)
- Claude 실행기: `~/.local/bin/claude.exe` 네이티브 실행 파일과 로그인 (확인 버전 2.1.247)
- Gemini 실행기: Antigravity CLI `agy` 설치(검증 버전 1.5.0)와 연결 방식 선택. Gemini API 키(`GEMINI_API_KEY`)를 권장한다. 개인 Google 계정 방식은 Google 약관 위반이 될 수 있어 위험 안내에 동의해야 쓸 수 있다(아래 "Gemini 연결 방식 고르기"). 기존 Gemini CLI의 개인 계정 지원 종료는 [공식 안내](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)를, 후속 CLI 설치와 시작 방법은 [Antigravity 문서](https://antigravity.google/docs/getting-started/)를 참고한다.
- 필수 플러그인: 기본값에는 없다. 꼭 유지해야 하는 플러그인이 있으면 프로필 파일의 `required_plugins`에 적는다.
- 선택: Artifact Writer(`artifact-writer@local-artifact-tools`). 설치돼 있으면 Codex 문서 쓰기에 사용하고, 없으면 Codex가 작업 폴더 안에서 직접 쓴다(아래 "문서 쓰기").

아래 명령은 이 저장소 루트에서 실행한다. 예시 경로와 ID는 실제 값으로 바꾼다.

작업함 기본 위치는 `~/.agent-bridge/bridge.db`다. `--db` 또는 환경변수 `AGENT_BRIDGE_DB`로 바꿀 수 있으며, 실행 데이터는 저장소 밖에 둔다. 프로필 기본 파일은 `profiles.json`이고, 별도 파일은 `--profiles`로 지정한다. 관련 명령에서 같은 DB와 프로필 파일을 사용해야 한다.

## 빠른 시작

```bash
agent-bridge send task.json --profile review
agent-bridge run-codex --once --profile review
agent-bridge receive --as claude-code
```

회신을 성공적으로 처리한 뒤 명시적으로 ACK한다. 후속 업무를 만들 때는 아래 "회신에서 후속 업무 만들기"의 `send --reply-to`를 사용한다.

```bash
agent-bridge ack <reply_id> --as claude-code
```

Codex가 받은 회신은 수신자를 맞춰 ACK한다.

```bash
agent-bridge ack <reply_id> --as codex
```

### 명령과 전달 규칙

- `send`: 작업 봉투를 큐에 넣는다. 같은 `message_id`와 같은 내용을 다시 보내도 새 작업을 만들지 않는다. 같은 `message_id`의 내용이 다르면 오류로 거부한다. 봉투에 `template`이 있으면 먼저 펼친다(아래 "작업 템플릿").
- `run`: Codex 실행기 풀(`--workers`개), Claude 실행기 하나, Gemini 실행기 하나를 한 프로세스에서 함께 돌린다. 검수 체인은 이 명령 하나로 끝까지 진행된다.
- `run-codex`, `run-claude`, `run-gemini`: 해당 클라이언트의 실행기만 개별로 돌린다. `--once`는 맡을 작업이 없으면 종료한다. 생략하면 계속 대기하며, 대기 중에는 SQLite만 조회하고 모델을 호출하지 않는다. 쓰기 작업에는 실행기의 `--allow-write` 허용이 별도로 필요하다.
- `receive --as <agent>`: 수신자에게 온 미ACK 결과·질문을 조회한다. 조회만으로 소비하지 않으므로 ACK 전에는 재전달된다. `--take-tasks`를 붙이면 작업도 직접 맡고 실행 시도 번호인 `attempt`를 받는다. 수신자 이름은 `claude-code`, `codex`, `gemini`다.
- `ack <reply_id> --as <agent>`: 처리한 회신을 ACK한다. 반복해도 안전하다. 수신자는 `message_id`로 중복 처리에 대비하고, 재시도 회신은 `attempt`와 회신 ID로 구분한다.
- `reply --to <message_id> --attempt <받은 번호> --summary <text>`: 직접 맡은 작업에 해당 시도 번호로 회신한다.
- `status`, `cancel <message_id>`, `requeue <message_id>`: 상태 확인, 취소, `blocked` 작업 재대기. 종료 미확인 상태인 `cleanup_pending`은 실제 종료를 확인하고 `confirm-stopped`를 실행하기 전에는 재대기할 수 없다.
- `confirm-stopped <message_id> --attempt <n>`: 운영자가 해당 시도의 프로세스 종료를 확인했음을 기록한다. 프로세스를 자동으로 종료하는 명령은 아니다(아래 "종료 미확인 처리").

Claude Code가 수동으로 작업을 처리하는 예:

```bash
agent-bridge receive --as claude-code --take-tasks
agent-bridge reply --to <message_id> --attempt <받은 번호> --summary "검토 결과"
```

### 회신에서 후속 업무 만들기

결과·질문 회신을 처리하면서 후속 업무를 만들 때는 원본 회신 ID와 단계 이름을 지정한다.

```bash
agent-bridge send followup.json --reply-to <reply_id> --followup-key <step-name>
```

CLI 옵션 대신 작업 봉투 JSON에 `reply_to`, `followup_key`를 지정해도 된다. `reply_to`는 원본 작업의 `message_id`가 아니라 결과 또는 질문의 회신 ID다. `followup_key`를 생략하면 `default`를 사용한다.

- 같은 `reply_to`+`followup_key`로 다시 제출하면 새로운 `message_id`를 주더라도 기존 후속 업무를 반환한다. 재전달이나 재시도 때문에 새 단계 이름을 만들지 않는다.
- 같은 `reply_to`+`followup_key`에 다른 내용이나 수신자를 지정하면 오류다. `message_id`가 같은데 내용이 다른 경우도 오류다.
- 의도적으로 다른 후속 단계를 만들 때만 별도 단계 이름을 사용한다.
- 후속 업무 저장과 원본 회신 ACK는 같은 트랜잭션에서 처리한다. 후속 업무 없이 회신만 처리할 때는 기존 `ack`를 사용한다.

모든 회신이 자동으로 후속 업무를 만드는 것은 아니다. 이 중복 방지는 브리지를 통해 `reply_to`를 지정해 제출한 후속 업무에 적용되며, `reply_to` 없는 임의 외부 작업에는 적용되지 않는다.

### 사용할 AI 고르기

켜 둔 AI끼리만 작업을 주고받는다. 꺼 둔 AI는 목록에는 남지만 작업을 받지 않고, 그 AI에게 보내는 작업은 거부된다. 대시보드의 [설정] 탭이나 아래 명령으로 바꾼다. 설정은 `~/.agent-bridge/clients.json`에 저장되며, 키나 토큰은 저장하지 않는다.

```bash
agent-bridge settings                      # 현재 설정 보기
agent-bridge settings --disable claude-code
agent-bridge settings --enable claude-code,gemini
```

실행 중인 실행기는 중단했다가 다시 시작해야 바뀐 설정이 적용된다.

### Gemini 연결 방식 고르기

Gemini는 연결 방식을 고르기 전에는 작업을 받지 않는다. 방식은 세 가지다.

- `api-key` (권장): Google AI Studio에서 만든 키를 사용자 환경변수 `GEMINI_API_KEY`에 넣는다. 실행할 때 `agy`에 `modelProvider: "gemini"` 설정을 넘기므로 사용자의 전역 `agy` 설정은 바꾸지 않는다. 사용량만큼 Google에 따로 과금될 수 있다.
- `account`: `agy`에 로그인한 개인 Google 계정을 쓴다. **Google 약관 위반이 될 수 있다.** [Google Antigravity FAQ](https://antigravity.google/docs/faq/)는 다른 프로그램이 Antigravity 로그인을 이용하는 것을 금지하고, 계정이 정지되거나 해지될 수 있다고 안내한다. 그래서 위험 안내에 동의해야 고를 수 있고, 동의 시각이 설정에 기록된다.
- `both`: 두 방식을 모두 허용한다. 평소에는 `--gemini-default`로 정한 방식을 쓰고, 작업 봉투의 `"gemini_auth": "api-key"` 또는 `"account"`로 작업마다 바꿀 수 있다.

```bash
agent-bridge settings --gemini-auth api-key
agent-bridge settings --gemini-auth account --accept-account-risk
agent-bridge settings --gemini-auth both --gemini-default api-key --accept-account-risk
```

키가 없거나, 고르지 않은 방식을 작업이 요청하거나, 동의 없이 개인 계정 방식을 쓰려 하면 해당 작업은 CLI를 실행하지 않고 이유와 함께 멈춘다. 실행 기록(`runtime[].auth`)에는 `gemini-api-key` 또는 `google-account`가 남는다.

### Gemini 실행 파일 지정

Antigravity CLI를 설치한 뒤, 자동으로 찾지 못하면 `~/.agent-bridge/clients.json`에 실행 파일의 절대경로와 모델을 지정한다.

```json
{
  "gemini": {
    "executable": "C:/Users/<user>/.agent-bridge/runtime/antigravity/agy.exe",
    "model": "gemini-4-argon-medium"
  }
}
```

`<user>`는 실제 사용자 폴더 이름으로 바꾼다. `model`은 현재 검증한 예시이며, 사용할 수 있는 모델에 맞춰 변경할 수 있다.

```bash
agent-bridge run-gemini --once
```

설정 파일의 실행 경로 대신 `--gemini-cli`로 절대경로를 지정할 수도 있다.

```bash
agent-bridge run-gemini --once --gemini-cli "C:/Users/<user>/.agent-bridge/runtime/antigravity/agy.exe"
```

### Claude 일반 업무 실행

`recipient: "claude-code"`인 일반 업무도 Claude 실행기가 처리한다. `workspace-write` 작업은 다음과 같이 실행기에서 쓰기를 허용한다.

```bash
agent-bridge run-claude --once --allow-write
```

작업 봉투에도 `sandbox: "workspace-write"`와 허용 범위인 `write_files`가 필요하다. Claude 일반 쓰기 작업은 기본 도구와 `auto` 권한 모드를 사용한다. 사용자 권한을 무시하는 우회 설정은 사용하지 않는다. 기존 검수 체인의 Claude 독립 검수는 계속 읽기 전용으로 실행한다.

### 외부 업무별 역할 설정

업무별 역할은 브리지 밖의 JSON 파일로 관리한다. 예를 들어 `C:/workflows/business.json`에 다음 내용을 저장한다.

```json
{
  "roles": {
    "research": {
      "agent": "gemini",
      "instructions": "자료를 분류하고 근거와 의견을 구분한다."
    }
  }
}
```

전송할 때 파일과 역할을 지정한다.

```bash
agent-bridge send task.json --workflow C:/workflows/business.json --workflow-role research
```

역할은 작업의 수신자와 업무 설명을 제공한다. `sandbox`나 `write_files` 권한을 부여하지 않으며, 실행기의 쓰기 허용을 대신하지 않는다. 역할의 수신자와 작업 봉투에 명시한 `recipient`가 충돌하면 오류로 거부한다.

## 작업 봉투

```json
{
  "message_id": "msg-auth-1",
  "task_id": "J06",
  "sender": "claude-code",
  "recipient": "codex",
  "goal": "로그인 오류 원인 확인",
  "acceptance": ["관련 테스트 통과"],
  "cwd": "C:/projects/my-repo",
  "profile": "review",
  "file_refs": [{ "path": "web/src/api/auth.js", "symbol": "login" }],
  "write_files": [],
  "sandbox": "read-only",
  "handoff_ref": "docs/handoff/claude/J06.md",
  "model": null,
  "effort": "low",
  "thread_id": null
}
```

- 필수: `message_id`, `task_id`, `sender`, `recipient`, `goal`, `cwd`.
- `profile`: 작업에 적용할 프로필. `send --profile`로도 지정할 수 있다. 작업 프로필은 `run-codex --profile`의 실행기 기본값보다 우선한다.
- `file_refs`: 경로와 선택 항목 `lines`(예: `"10-40"`) 또는 `symbol`. 해시가 없으면 보낼 때 계산한다.
- `write_files`: 수정해도 되는 파일 또는 디렉터리 경로. 비어 있지 않으면 `sandbox`가 `workspace-write`여야 한다. 실행기에도 별도로 쓰기 권한이 필요하다.
- `base_revision`, `handoff_ref`, `short_summary`: 기준 리비전, 인계 문서 참조, 짧은 요약을 전달할 때 사용하는 필드.
- `model`, `effort`: 이전 작업의 설정이 이어지지 않도록 매 턴 전달한다. 기록값은 요청값이며 실제 적용을 항상 검증했다는 뜻은 아니다.
- `thread_id`: 이전 회신의 값을 넣으면 해당 클라이언트의 대화 또는 세션을 이어 쓴다. Codex·Claude·Gemini 각각의 이어쓰기와 질문에 대한 답변에 사용한다. 같은 `recipient`+`thread_id`를 사용하는 작업은 동시에 실행하지 않는다.
- `reply_to`, `followup_key`: 결과·질문 회신에서 후속 업무를 만들 때 사용하는 원본 회신 ID와 단계 이름. 같은 조합은 한 업무로 처리하며, 기본 단계 이름은 `default`다(위 "회신에서 후속 업무 만들기").
- `chain`: `{ "review": true }`를 넣으면 검수 체인으로 돈다(아래). `claude-code → codex` 작업에만 쓸 수 있다.
- `recovery`: `false`이면 이 작업의 자동 복구를 끈다(아래 "자동 복구"). 생략하면 켜져 있다.

### 검수 체인

`chain.review`가 있는 작업은 Codex 구현 → Claude 독립 검수 → 반려 시 지적 사항만 담은 Codex 재작업 → 재검수 순서로 진행한다. 기본값은 `max_rounds: 2`, `review_model: claude-sonnet-5-5`, `review_effort: high`, `review_timeout_ms: 1200000`이다.

- 다음 단계 작업은 결과 저장과 같은 트랜잭션에서 결정적 ID(`<root>:review:n`, `<root>:rework:n`, `<root>:final`)로 만든다. 요청자에게는 질문과 `<root>:final`만 전달되고 체인 내부 회신은 자동 ACK된다.
- 검수는 Claude가 읽기 전용으로 한다. 브리지가 기준 리비전 대비 diff 파일을 만들어 넘기며, 커밋하지 않은 새 파일도 추가분으로 포함한다.
- `boundary_review`가 없거나 권한·인증 변경이 검수되지 않은 pass는 reject로 저장한다. 한도에 닿으면 final의 상태가 `exhausted`다.
- 체인이 진행되는 동안 루트의 `write_files` 잠금을 유지한다. 루트 하나를 `cancel`하면 체인 전체가 멈춘다. 진행 상황은 `status`의 `chain` 항목으로 본다.
- 재작업·검수 대상 같은 내부 필드(`pending_review`, `findings`, `implementation`, `current`)는 요청자가 봉투에 넣을 수 없다.

### 작업 템플릿

자주 쓰는 봉투는 `templates.json`에 두고 이름과 변수만 보낸다. 브리지가 큐에 넣기 전에 펼치므로 에이전트가 템플릿을 읽는 호출이 없다. 봉투에 직접 쓴 필드가 템플릿 값보다 우선한다. 없는 템플릿, 빠진 변수, 쓰지 않은 변수는 거부한다.

```json
{ "message_id": "msg-img-1", "task_id": "IMG02", "template": "image-photo",
  "vars": { "out": "seoul-night.png", "prompt": "..." } }
```

`image-photo`는 저장소 밖 `~/.agent-bridge/images`(환경변수 `AGENT_BRIDGE_IMAGE_DIR`로 변경 가능)를 작업 폴더로, `image` 프로필과 effort `low`를 쓴다. 저장소 안에서 돌리면 저장소의 AGENTS.md가 매 호출에 실리기 때문이다.

#### 이미지 작업 실행

```bash
node image-job.mjs --name photo-01 --prompt "vertical 2:3 portrait photograph of ..."
```

`image-job.mjs`가 봉투 전송, `run-codex --once --allow-write --profile image` 실행, 회신 확인, 생성 파일 복사를 한 번에 한다. Codex는 생성된 파일의 절대 경로만 보고하고, `<작업 폴더>/<name>.png`로의 복사는 이 스크립트가 한다(전용 홈에서는 셸 복사가 막히거나 멈춘다). 같은 이름의 파일이 있으면 덮어쓰지 않고 실패한다. 한 번에 약 8만~28만 토큰이 든다(도구가 고른 해상도에 따라 다르다).

반복 생성으로 토큰이 새지 않도록 하루 한도가 있다. 작업 폴더의 `.image-job-ledger.json`이 그날의 장수와 토큰 합계를 기록하고, 장수 4장(`IMAGE_JOB_DAILY_MAX`) 또는 토큰 80만(`IMAGE_JOB_DAILY_TOKENS`)에 닿으면 새 작업을 거부한다. 실패하거나 질문으로 끝난 시도도 센다. 스크립트는 검수 뒤 자동 재생성을 하지 않는다. 다시 만들지는 사람이 정한다.

#### `image` 프로필의 전용 Codex 홈

`image` 프로필은 `CODEX_HOME`을 덮어쓰지 않고 일반 Codex와 같은 인증·설정·세션 저장 공간을 사용한다. 기본 위치는 `~/.codex`이며, 실행 환경에 `CODEX_HOME`이 지정되어 있으면 그 값을 따른다. 과거의 `.codex-image` 분리는 전역 스킬 지침을 줄이려는 목적이었지만 인증까지 분리해 만료·갱신 실패를 일으켜 제거했다. 기존 `.codex-image` 세션과 결과 파일은 보존하며 자동 이전하거나 실패 작업을 재시도하지 않는다. 새 기본 홈에서 과거 이미지 스레드 ID를 바로 재개할 수 있다고 가정하지 않는다.

- `auth.json`: `~/.codex/auth.json`을 복사한다. 비밀 값이므로 저장소에 넣지 않는다.
- `config.toml`: `model = "gpt-6-luna"`, `model_reasoning_effort = "low"`, `sandbox_mode = "workspace-write"`, 그리고 `[windows]` 아래 `sandbox = "elevated"`.
- `AGENTS.md`: "Image generation only" 제목 아래 "이미지는 image_gen 도구로 만들고 스킬 파일을 읽지 않는다"는 두 줄.

생성 결과는 `<CODEX_HOME>/generated_images/<thread>/exec-*.png` (기본 `~/.codex/generated_images/<thread>/exec-*.png`)에 쌓인다.

## 프로필과 필수 훅

기본 프로필은 `standard`, `review`, `code`, `document`, `light`다. `light`는 선택 플러그인 없이 `file_refs`만 전달하는 단순 작업용이며, 아래 `codex_config`로 스킬 목록과 저장소 AGENTS.md도 싣지 않는다. 목록과 설정을 확인하고, 모델 호출 없이 실제 Codex 설정 적용을 점검할 수 있다.

```bash
agent-bridge profiles
agent-bridge inspect-profile --profile review
agent-bridge inspect-profile --profile review --profiles my-profiles.json
agent-bridge run-codex --once --profile review --profiles my-profiles.json
```

GUI에서도 프로필 JSON을 편집할 수 있다.

`--lean`은 이제 `review` 프로필의 별칭이다. `features.plugins=false`로 플러그인과 훅을 일괄 비활성화하는 방식은 더 이상 사용하지 않는다. 과거 약 15% 절감 측정값은 현재 프로필에 적용할 수 없다. 플러그인을 개별로 끄는 프로필은 첫 호출 입력을 거의 줄이지 못했다(2026-10-30 같은 이미지 작업: `code` 27,822, `light` 28,007). 토큰을 줄이는 큰 요인은 도구 호출 수와 작업 폴더의 AGENTS.md다.

프로필의 `codex_config`로 매 호출에 실리는 맥락을 줄일 수 있다. 허용 키는 둘뿐이며, 둘 다 접근 범위는 바꾸지 않는다.

```json
"codex_config": { "project_doc_max_bytes": 0, "skills.include_instructions": false }
```

- `project_doc_max_bytes: 0`: 작업 폴더 쪽 저장소 AGENTS.md를 싣지 않는다. 전역 `~/.codex/AGENTS.md`는 그대로 실린다.
- `skills.include_instructions: false`: 스킬 목록을 싣지 않는다. 전역 AGENTS.md가 경로로 지정한 스킬 파일은 여전히 열 수 있다.

실행기는 이 값을 app-server의 `-c` 설정으로 넘기고, `config/read`로 실제 적용을 확인한 뒤 실행한다. 기본 프로필 중에는 `light`에만 켜 두었다. 스킬이나 저장소 규칙이 필요한 작업은 `light`를 쓰지 않는다.

2026-11-05 측정에서 `gpt-6-luna`/low로 도구 호출 없는 한 번 응답을 실측했다. 호출 한 번의 입력이 29,462에서 18,077토큰으로 11,385토큰(약 39%) 줄었다. 빠진 분량은 스킬 목록 39.8k자, 저장소 AGENTS.md 22.6k자다(`codex debug prompt-input`으로 확인). 저장소 밖 작업 폴더에서는 AGENTS.md 몫이 원래 없어 절감이 더 작다.

Claude·Gemini 실행에서는 네이티브 `--json-schema`로 전달하면서 프롬프트 본문에도 중복하던 JSON schema 본문만 제거했다. 모델에 전달하는 스키마는 유지하며, 목표(`goal`)와 완료 조건(`acceptance`)도 원문 그대로 전달한다. 요청당 본문은 602자 줄었지만 실제 토큰 수와 전체 절감률은 측정하지 않았다.

### 훅 보존과 검증

- 기존 활성 훅은 자동 보존한다. `required_plugins`는 기본값이 비어 있으며, 적어 둔 플러그인은 어떤 프로필에서도 끄지 않고 대시보드에서 지울 수도 없다.
- `optional_hooks`에 명시된 선택 훅만 `profiles.<name>.hooks`에서 조절할 수 있다. 정확히 일치하는 훅 key와 JSON boolean인 `true` 또는 `false`를 사용한다.
- 필수 플러그인 훅과 관리 훅은 끌 수 없다. 프로필 적용 과정은 현재 신뢰 상태와 내용 해시도 비교하며, 신뢰 승인을 대신 수행하지 않는다.
- 전역 Codex 설정 파일은 바꾸지 않는다. 실행 프로세스의 `-c` 옵션으로 설정을 적용한다.
- 적용 전 baseline과 적용 후의 `config/read`, `hooks/list` 결과를 비교한다. 적용에 실패하면 작업은 `blocked`가 된다.

이 PC의 `review` 프로필 실제 점검에서는 활성 훅 7개가 유지됨을 확인했다. 이는 해당 환경의 설정 점검 결과이며, 다른 환경에서도 같은 개수라는 보장은 아니다.

실제 설정 검증은 특정 도구 호출이나 산출물 보호가 실행됐다는 증거와 다르다. `hook/completed` 이벤트는 별도로 기록하며, GUI에서 필수 훅 기록을 확인할 수 있다.

### 작업·회신 필터

프로필의 `input_fields`는 기본 필드와 `file_refs`, `base_revision`, `handoff_ref`, `short_summary` 중 전달할 작업 필드를 정한다. `goal`, `acceptance`, `write_files`, `sandbox`는 항상 포함한다.

회신은 `output_fields`로 선택 출력 필드를 정하지만, `status`, `question`, `acceptance`, `changed_files`는 항상 유지한다. 전체 결과는 DB에 보존하고, `receive`는 필터링된 전달용 `delivery` 필드를 제공한다. GUI에서는 원본 상세를 열람할 수 있다.

필터는 수동 Claude 처리에도 적용된다. `receive --as claude-code --take-tasks`에는 작업 필터가, `reply`에는 회신 필터가 적용된다. 다만 Claude 런타임의 훅·플러그인을 자동 설정하지는 않는다. 현재 Claude 일반 업무 실행기와 읽기 전용 검수 실행기가 있으며, 위의 Codex 프로필 플러그인·훅 적용 점검이 Claude나 Gemini에 그대로 적용되는 것은 아니다.

## 로컬 도구 어댑터

등록한 로컬 JSON stdin/stdout 도구에도 필드 필터를 적용할 수 있다. 다음 설정 조각을 기존 프로필 파일의 해당 항목에 통합해 `my-profiles.json`으로 저장한다. 기존 필수 플러그인과 훅 설정은 유지한다.

```json
{
  "profiles": {
    "document": {
      "adapters": ["document-tool"]
    }
  },
  "adapters": {
    "document-tool": {
      "command": "node",
      "args": ["C:/tools/document-tool.mjs"],
      "input_fields": ["brief.title", "brief.sections", "sources"],
      "output_fields": ["artifact_path", "summary", "warnings"]
    }
  }
}
```

`input.json` 예:

```json
{
  "brief": {
    "title": "운영 안내",
    "sections": ["설치", "실행", "문제 해결"]
  },
  "sources": ["제공된 운영 자료"]
}
```

```bash
agent-bridge call-adapter document-tool input.json --profile document --profiles my-profiles.json
```

`C:/tools/document-tool.mjs`는 사용자가 준비해야 하는 외부 도구이며 기본 제공되지 않는다. JSON을 stdin으로 받고 JSON을 stdout으로 반환해야 한다.

- 입력은 선택된 필드만 도구의 stdin으로 전달한다.
- 출력은 선택된 필드만 stdout으로 전달하되, `status`와 `error`는 항상 전달한다.
- 전체 출력 원본과 stderr는 DB 옆 `adapter-runs/<UUID>.json`에 보존한다. 전달 필터는 원본 저장을 없애는 기능이 아니다.
- 실행 경로와 인수는 신뢰할 수 있는 설정이어야 한다.

필터는 등록한 로컬 어댑터 호출 경로에만 적용된다. 사용자 플러그인 내부나 직접 호출한 도구의 입출력을 전역 차단하지 않으며, 설치된 Artifact Writer 훅의 입력을 임의로 잘라내지 않는다.

## 로컬 현황 화면과 병렬 실행

```bash
agent-bridge serve --repo C:/projects/my-repo --workers 2
```

포트, 쓰기 권한, DB와 프로필 파일을 지정하는 예:

```bash
agent-bridge serve --repo C:/projects/my-repo --workers 2 --port 8787 --allow-write --db C:/bridge-data/bridge.db --profiles my-profiles.json
```

접속 URL은 서버가 출력한 `127.0.0.1` 주소를 사용한다. 서버를 시작하는 것만으로 작업이 실행되지는 않는다. 화면의 실행기 시작·중단 버튼으로 제어한다.

- `--workers`는 기본 1이며 양의 정수만 허용한다. 여러 워커는 같은 DB의 파일 겹침 잠금과 세션 보호를 공유한다. 같은 `recipient`+`thread_id`는 동시에 실행하지 않는다. 파일 범위가 겹쳐도 읽기/읽기는 허용하지만, 읽기/쓰기와 쓰기/쓰기는 겹침이 풀릴 때까지 대기한다.
- `--port`는 선택 사항이다. 쓰기 작업을 허용하려면 서버 시작 시 `--allow-write`를 지정한다.
- 읽기 전용으로 시작한 서버의 권한은 화면에서 쓰기 허용으로 높일 수 없다.
- 화면에서 상태, 시도별 토큰 사용량, 결과와 원본 상세, 필수 훅 기록을 확인하고 작업 제출·취소·`blocked` 재시도·질문 답변·ACK를 수행할 수 있다.
- 프로필 JSON 편집과 Git worktree 생성·상태 확인·선택·잠금도 지원한다.

동시 실행 보호는 같은 SQLite DB를 사용하는 협력 실행기 범위에 적용된다. 외부 편집기의 변경을 차단하거나 OS 접근을 통제하는 기능은 아니다.

브라우저 토큰과 Origin/Host 검사는 로컬 사용을 위한 보호다. 원격 공개 서비스용 인증은 제공하지 않으므로 공개 서비스로 노출하지 않는다.

## Git worktree

작업 폴더를 분리해 병렬 작업을 진행할 수 있다.

```bash
agent-bridge worktrees --repo C:/projects/my-repo
agent-bridge worktree-create review-1 --repo C:/projects/my-repo --base HEAD
```

생성 위치는 Git common dir의 부모 아래 `.agent-bridge-worktrees/<name>`이고, 브랜치는 `bridge/<name>`이다. 잠금과 작업 전송에는 생성 결과에 표시된 절대경로를 사용한다. 아래는 Git common dir이 `C:/projects/my-repo/.git`인 경우의 예다.

```bash
agent-bridge worktree-lock C:/projects/my-repo/.agent-bridge-worktrees/review-1
agent-bridge send task.json --worktree C:/projects/my-repo/.agent-bridge-worktrees/review-1 --repo C:/projects/my-repo --profile review
agent-bridge worktree-unlock C:/projects/my-repo/.agent-bridge-worktrees/review-1
```

GUI에서도 생성, 상태 확인, 작업 대상 선택, 잠금을 할 수 있다.

- 지정한 `--base`의 커밋된 내용만 복제한다. 원래 작업 폴더의 미커밋 변경은 옮기지 않는다.
- Git worktree 잠금은 제거·prune 방지용이며 파일 편집 잠금이 아니다. 작업 간 파일 겹침 잠금은 `BridgeStore`가 담당한다.
- 자동 병합·삭제·push는 하지 않는다.
- 폴더별 파일이 분리돼도 같은 DB나 외부 자원까지 자동 격리되지는 않는다.

## 상태와 실행 시도

| 상태 | 뜻 |
| --- | --- |
| `queued` | 대기. 진행 중 작업과 읽기/쓰기·쓰기/쓰기 범위가 겹치거나 같은 `recipient`+`thread_id`를 사용하면 보호가 풀릴 때까지 대기 |
| `working` | 실행기나 사람이 맡아 진행 중 |
| `ready` | 결과 회신 완료 |
| `blocked` | 질문, 실패, 권한 부족, 프로필 적용 실패, 실행기 중단, 입력 변경 등. `status_reason`에 이유 기록 |
| `cancelled` | 취소 확인 |

`integrated`(통합 확인)는 협업 런북의 상태이며 브리지가 정하지 않는다. ACK도 수신자의 회신 처리 확인일 뿐 통합 확인은 아니다.

작업을 맡을 때마다 `attempt`가 증가한다. 완료·상태 갱신 시 현재 실행 시도와 실행 소유자를 대조한다. 실행 소유자 이름은 로컬 협력을 위한 식별자이지 인증 수단이 아니다.

회신 ID는 `<message_id>:attempt:<n>:result` 또는 `<message_id>:attempt:<n>:question`이다. 이전 시도의 회신은 기록으로 보존하며, 같은 시도의 같은 완료 회신은 중복 저장하지 않는다.

`status` 출력의 `attempt_usage`에는 시도별 사용량이 남는다. 실패·취소 시에도 서버가 보고한 사용량을 저장하고, 재시도해도 이전 사용량을 보존한다. 보고되지 않은 사용량을 0으로 만들어내지 않는다.

### 멈춘 이유 분류

`blocked` 작업은 `status_reason`을 읽어 `failure: {kind, execution}`을 덧붙여 보여 준다(`status`·`list` 출력, 현황 화면, `/api/state`). 분류 자체는 상태를 바꾸지 않으며 로그인도 하지 않는다. 원문 `status_reason`은 그대로 남는다. 일부 실패는 아래 "자동 복구" 규칙에 따라 다시 대기열에 들어간다.

- `kind`: `setup`(실행 설정), `input_changed`(입력 변경), `scope`(범위 밖 변경), `observation`(변경 확인 불가), `rule`(필수 규칙 미충족), `cleanup`(종료 미확인), `format`(응답 형식), `timeout`, `auth`, `quota`, `outage`, `process_exit`, `unknown`. 브리지가 직접 남기는 문구는 정확히 대응시키고, 제공자의 오류 문구(`auth`·`quota`·`outage`)는 키워드로 추정하므로 현황 화면에는 "~로 보임"으로 표시한다.
- `execution`: `not_started`(실행 전에 멈춤이 확실함), `ran`(에이전트가 실행된 뒤 멈춤이 확실함), `unknown`(이유만으로는 알 수 없음). `unknown`이나 `ran`이면 변경 파일을 확인한 뒤 `requeue`한다. 같은 작업을 자동으로 다시 실행해도 되는지는 이 값으로 판단하지 않는다.
- 질문(`question`)과 `blocked`가 아닌 상태는 분류하지 않는다.

### 자동 복구

`blocked`로 멈춘 시도가 아래 조건을 모두 만족하면 실행기가 사람의 `requeue` 없이 다시 대기열에 넣는다. 조건을 하나라도 확인하지 못하면 지금처럼 `blocked`로 남고, 남은 이유를 `recovery` 기록에 적는다.

- 대상 실패: `quota`, `outage`, `process_exit`. 인증(`auth`), 시간 초과, 브리지 자체 검사, 분류 불가는 대상이 아니다. 인증 문제를 로그인으로 우회하지 않는다.
- 시작하지 않았다는 증거: 세 가지가 모두 있어야 한다.
  - 도구 호출 0회: 연결기가 그 시도의 이벤트에서 센 명령·파일 수정·외부 도구 호출 수(`runtime[].activity.tool_calls`). Codex는 텍스트가 아닌 항목을, Claude·Gemini는 도구 사용 이벤트를 센다. 셀 수 없으면 `null`이고 재시도하지 않는다.
  - 변경 0건: 실패한 시도도 작업 전후를 비교한다(`change_observation`). 관찰을 끝내지 못했거나 바뀐 파일이 있으면 재시도하지 않는다.
  - 프로세스 종료 확인: `cleanup_pending`이 아니어야 한다.
- 제외: 봉투의 `recovery: false`, 검수 체인 작업, 계약 작업, 로컬 도구 작업, `image` 프로필(하루 생성 한도가 `image-job.mjs`에 있다), 취소 요청된 작업.
- 같은 에이전트로 재시도: 오류 문구에 상대 시간("try again in 2 hours", `Retry-After: 90`)이 있으면 그만큼, 없으면 첫 번째는 5분, 두 번째는 30분 뒤로 `not_before`를 정해 `queued`로 돌린다. 작업 하나에 최대 2회이고, 사람이 `requeue`해도 횟수는 초기화되지 않는다. 기다릴 시간이 6시간을 넘으면 재시도하지 않는다.
- 에이전트 대기: `quota`이면 그 에이전트의 다른 대기 작업도 같은 시각까지 시작하지 않는다(최대 6시간). 대기 중인 작업의 이유에 `waiting: <agent> usage limit until <시각>`이 남는다.
- 다른 에이전트로 넘기기: 사용자가 관리하는 `~/.agent-bridge/recovery.json`에 적힌 조합만 쓴다. 파일이 없으면 꺼져 있고, 항목 하나라도 잘못되면 파일 전체를 무시한다(같은 에이전트 재시도는 그대로 동작한다). 봉투로는 끌 수만 있고 조합을 추가할 수 없다.

```json
{ "fallback": [
  { "from": "gemini", "to": "codex", "on": ["quota", "outage"], "profiles": ["light"], "model": "gpt-6-luna", "effort": "low" }
] }
```

  - 넘길 때는 수신자·모델·effort만 바꾸고 목표, 완료 조건, 작업 폴더, 쓰기 범위, 샌드박스, 프로필, 참조 파일은 그대로 둔다. 모델 이름은 에이전트마다 다르므로 항목에 적은 값을 쓴다.
  - 작업 하나에 한 번만 넘긴다. 이어쓰기(`thread_id`) 작업이나 보낸 쪽 에이전트로는 넘기지 않는다. 일치하는 항목이 있으면 기다리지 않고 바로 넘긴다.
- 기다리는 작업은 `queued`로 남으므로 `--once` 실행기는 기다리지 않고 끝난다. 시각이 지나면 다음에 도는 실행기(`run`, `serve`, 다음 `--once`)가 맡는다. 기다리는 동안 `cancel`하면 바로 취소된다.
- 기록: 결정마다 작업의 `recovery` 목록에 `{action: retry|fallback|stay, kind, attempt, at, ...}`이 쌓인다. `status` 출력의 `recovery`·`retry_at`과 현황 화면 작업 상세에서 볼 수 있다. `stay`의 `code`는 남은 이유다(`tools_ran`, `workspace_changed`, `retries_used` 등).
- 확인하지 못한 것: 실제 Claude·Codex·Gemini의 한도·장애 오류 문구와 도구 이벤트 형식은 가짜 실행기로만 확인했다. 문구가 분류되지 않으면 재시도가 일어나지 않을 뿐이다. Gemini(`agy`)가 도구 이벤트를 내보내지 않거나 오류를 JSON이 아닌 줄로 내면 그 시도는 재시도 대상이 아니다.

### 종료 미확인 처리

프로세스 종료를 확인하지 못한 시도는 `cleanup_pending`으로 남으며, 실행기를 재시작해도 파일·세션 보호를 유지한다. 종료 확인 전에는 재시도하거나 체인 ID를 재사용할 수 없다.

운영자가 해당 시도의 프로세스가 실제로 종료됐는지 확인한 뒤 다음 명령으로 기록한다. 그다음 변경 파일을 확인하고 `requeue`한다.

```bash
agent-bridge confirm-stopped <message_id> --attempt <n>
agent-bridge requeue <message_id>
```

`confirm-stopped`는 운영자의 종료 확인을 기록하는 명령이지 자동 프로세스 종료 도구가 아니다. 종료 여부가 불명확한 상태에서 보호를 해제하는 용도로 사용하지 않는다.

## 권한과 안전 경계

- Codex 실행기는 `approvalPolicy: never`인 무인 실행이며 기본은 읽기 전용이다. Codex가 보내는 승인·질의 요청에는 거절로 응답한다.
- 쓰기 작업은 사람이 해당 실행기의 `--allow-write` 또는 `serve --allow-write`로 허용한 경우에만 실행한다. Codex는 `run-codex --allow-write`, Claude 일반 업무는 `run-claude --allow-write`, Gemini는 `run-gemini --allow-write`를 사용한다. 메시지나 프로필, 외부 역할만으로 권한이 늘지 않는다.
- `write_files` 잠금은 `cwd` 기준 절대경로로 변환하고 `..`를 정리한다. junction/symlink를 해석한 실제 경로와 Windows 대소문자 정규화를 이용해 겹침을 판단한다. 없는 경로는 가장 가까운 기존 상위 폴더의 실제 경로를 기준으로 계산한다. 디렉터리 범위도 잠금 대상이다.
- 경로 잠금은 같은 DB를 사용하는 협력 실행기 간 스케줄링이다. OS 접근 통제나 외부 편집기의 변경 차단을 보장하지 않는다.
- 실행기가 작업 중 멈추면 자동 재실행하지 않고 `blocked`로 둔다. 변경 파일을 확인한 뒤 `requeue`한다. `cleanup_pending`이면 먼저 실제 종료를 확인하고 `confirm-stopped`로 기록해야 한다.
- Ctrl+C/SIGTERM을 받으면 진행 중 턴에 interrupt를 요청하고 다음 작업은 시작하지 않는다. `interrupted` 확인 후 `cancelled`가 된다. 초기화 중 종료되거나 실행 오류로 중단 확인을 받지 못하면 `blocked`로 남을 수 있다. 프로세스 종료 시 3초의 정리 대기를 유지한다. 프로세스 종료가 미확인된 경우에는 `cleanup_pending`으로 파일·세션 보호를 유지한다.
- Claude의 읽기 전용 작업과 독립 검수는 `--tools Read,Grep,Glob`, `--permission-mode dontAsk`로 실행하고, 허용 밖 도구를 시도하면 판정과 관계없이 `blocked`로 둔다. `--allowedTools`는 주지 않는다. 맨 `Read` 허용 규칙은 모든 경로를 열기 때문이다. 대신 읽기는 작업 폴더와 `--add-dir`로 준 diff 임시 폴더로 제한되고, 밖을 읽으려 하면 거부되어 `tool_log`에 `denied`로 남는다(2026-10-30 실측). 실행 파일은 절대경로의 네이티브 파일만 쓰며 셸을 거치지 않는다.
- Claude 일반 `workspace-write` 작업은 봉투의 `write_files`와 실행기의 `--allow-write`가 있어야 실행하며, 기본 도구와 `auto` 권한 모드를 사용한다. 기존 독립 검수의 읽기 전용 도구 제한은 그대로 유지한다.
- 읽기 전용 도구 제한과 `workspace-write` 실행 허용은 별개다. 모든 클라이언트에 같은 OS 수준 샌드박스가 보장되는 것은 아니다. 브리지가 클라이언트의 전역 계정 설정을 임의로 변경하지 않는다.
- 문서 쓰기(`.md`·`.txt`·`.html`·`.json`·`.csv`·`.xml`·`.svg`): Artifact Writer가 없는 PC에서는 Codex가 작업 폴더 안에서 직접 쓰고, 작업 뒤 `write_files` 범위 검사는 그대로 적용된다. Artifact Writer 플러그인을 설치한 PC에서는 이 플러그인이 이런 파일의 직접 쓰기를 막고 전용 MCP 도구 세 개(`register_artifact`, `write_artifact`, `artifact_status`)를 요구한다. 그 도구가 `approvalPolicy: never`에서 거부되어 작업이 멈추던 문제를 `artifact-runtime.mjs`가 푼다. `--allow-write` 실행기가 `workspace-write` 작업을 돌릴 때만 이 세 도구를 감싸는 중계 서버로 대체하며, 호출마다 `target`이 작업의 `write_files` 안인지 검사하고 다른 도구·메서드는 거절한다. 일반 승인 정책과 필수 훅은 그대로다. 실행기를 재시작해야 적용된다. 단, 작성 도구는 별도 Codex 세션(`codex exec`)을 띄우므로 그 토큰은 브리지의 `turn_usage`에 잡히지 않는다.

쓰기 실행 예:

```bash
agent-bridge run-codex --once --profile code --allow-write
```

작업 봉투에도 허용 범위인 `write_files`와 `sandbox: "workspace-write"`가 필요하다.

### 실행 전후 입력 변경 검사

입력 파일·디렉터리를 실행 시작과 종료에 비교한다. 폴더 입력은 선언한 `write_files` 하위만 비교에서 제외하고, 나머지 읽기 전용 자식은 계속 검사한다. 큐 SQLite DB와 그 `-wal`, `-shm` 파일도 비교에서 제외한다.

실행 중 외부 입력 변경이 확인되면 작업을 `blocked`로 두고 회신을 발행하지 않는다. 비교 결과는 runtime receipt의 `input_versions`에 `before`, `after`, `changed`, `exclusions`로 기록하며, 성공 회신에도 같은 정보를 남긴다. 기존 `input_hashes`와 회신 이후 변경을 확인하는 `stale_inputs` 기능은 유지한다.

이 검사는 선언된 입력의 실행 전후 비교이며, 외부 편집을 막거나 선언되지 않은 모든 파일의 변경을 탐지하는 기능은 아니다.

## 회신 읽기

전체 회신에는 `summary`, 완료 조건별 `acceptance`(`pass`/`fail`/`unverified`와 근거), `changed_files` 등이 기록된다. 전달용 출력은 프로필 필터의 영향을 받는다.

- `changed_files.reported`: 에이전트가 보고한 파일.
- `changed_files.observed`: 작업 폴더(`cwd`)를 실행 전후로 비교해 실제로 바뀐 경로. 에이전트 보고와 무관하게 프로그램이 관찰한다. git 저장소에서는 git이 보는 수정·신규 파일과 `write_files`로 선언한 경로(무시 파일 포함)를, git이 아니면 폴더 전체를 해시한다. `.gitignore`로 무시되고 `write_files`에도 없는 파일, 다른 작업이 쓰기로 잡은 범위, 브리지 DB는 보지 않는다.
- `changed_files.outside_scope`: 에이전트가 보고한 파일 중 `write_files` 밖에 있는 것. 관찰된 변경이 `write_files` 밖이면 회신을 만들지 않고 작업을 `blocked`로 멈춘다(`observed writes outside task scope`). 관찰을 끝내지 못한 경우(파일 1만 개·64MB 초과, git 상태 읽기 실패, 실행 중 HEAD 변경)도 성공으로 처리하지 않고 멈춘다.
- `changed_files.changes`: 관찰된 경로마다 `created`/`deleted`/`modified`/`state-only`(내용은 같고 git 상태만 바뀜)와 전후 바이트·줄 수. 바이너리의 줄 수는 `null`이다. 실행 전 깨끗했던 추적 파일의 이전 크기는 `HEAD`에서 읽는다.
- `input_hashes`: 기존 입력 해시 기록.
- `input_versions`: 실행 시작·종료의 입력 비교 결과. `before`, `after`, `changed`, `exclusions`를 runtime receipt와 성공 회신에 기록한다. 실행 중 외부 입력 변경이 확인된 작업은 `blocked`가 되어 회신을 발행하지 않으므로 runtime receipt에서 확인한다.
- `stale_inputs`: 회신 이후 내용이 바뀐 입력 파일. 비어 있지 않으면 회신을 현재 코드의 결과로 사용하지 않는다.
- `turn_usage`: 이번 턴의 토큰 사용량으로, Codex가 보고한 누적값의 차이다. 미보고 사용량을 0으로 간주하지 않는다.

에이전트 답이 지정 형식이 아니면 원문을 `final_text`에 남기고 완료 조건은 모두 `unverified`로 둔다. 필터에서 제외된 상세는 GUI의 원본 결과에서 확인한다.

`receive`만으로 전달이 완료되지는 않는다. 후속 업무 없이 성공적으로 처리했다면 해당 회신 ID를 ACK해야 재전달이 멈춘다. 후속 업무를 만들 때는 `send --reply-to`를 사용하면 후속 업무 저장과 원본 회신 ACK를 함께 처리한다.

## 업데이트 호환성

기존 SQLite DB는 데이터를 보존하며 `attempt` 필드, `attempt_usage` 테이블, `runtime_receipts` 테이블을 추가하는 마이그레이션을 적용한다. 기존 회신 전달 상태도 보존한다. 구형 `blocked` cleanup/stale 상태에도 마이그레이션을 적용해 종료 미확인 상태의 파일·세션 보호를 유지한다.

구버전 실행기와 새 실행기를 같은 DB에 동시에 사용하지 않는다. 기존 실행기를 종료한 뒤 같은 DB를 사용하는 실행기를 새 버전으로 맞춘다. 기존 자동화도 후속 업무 없는 회신 처리 후에는 명시적 ACK를 보내고, 후속 업무 생성에는 `reply_to`와 `followup_key`를 사용하도록 갱신한다. 수동 `reply`에는 수신한 `attempt`를 전달해야 한다.

## 시험

```bash
node --test __tests__/*.test.mjs
```

시험은 `__tests__/fixtures/fake-app-server.mjs`(가짜 Codex), `__tests__/fixtures/fake-claude.mjs`(가짜 Claude)와 임시 실제 Git 저장소를 사용한다. 실제 모델은 호출하지 않는다. 실제 Codex 프로필 적용 여부는 별도로 `inspect-profile`로 점검한다.

자동 테스트 109개를 통과했다. 별도로 실제 Node 프로세스 9개를 사용한 큐 경쟁 검증에서 원본 제출 300건은 작업 60개로, 후속 제출 1,080건은 작업 60개로 처리됐으며 충돌 0건, 미ACK 0건을 확인했다. 이는 큐 경쟁과 중복 방지 검증이며 실제 모델 실행 검증은 아니다.

별도 실제 실행에서는 Claude Code·Codex·Gemini 사이의 6방향 메시지 전달과 응답·ACK, Claude 일반 쓰기 작업의 Write·Bash 사용을 확인했다. 이는 해당 통신·도구 실행의 검증이며, 전체 운영 워크플로우 완성이나 자동화 시작을 뜻하지 않는다.

## 아직 없는 것

- 반려 → 재작업 → 재검수의 처음부터 끝까지 실제 실행. 2026-10-30에 실제 Claude 검수가 변경 없는 보고를 reject하고 지적 사항만 담은 재작업 작업이 만들어지는 것까지 확인했다(Codex 구현 보고는 꾸며 넣음). 실제 Codex의 재작업 실행과 2회차 검수의 세션 재개는 가짜 실행기로만 확인했다.
- 검수자가 시험을 실행해 확인하는 기능. 읽기 전용이라 실행이 필요한 완료 조건은 `unverified`로 남는다.
- Windows에서 Claude 프로세스 트리 종료(`taskkill /T`)의 실제 확인. 시험은 명령을 대체해 확인했다.
- Claude 런타임 훅·플러그인 자동 설정.
- 열린 데스크톱 채팅으로의 자동 전달, MCP 노출.
- 관찰 범위 밖 파일(`.gitignore`로 무시되고 `write_files`에도 없는 파일, 작업 폴더 밖)의 변경 탐지와 되돌리기. 관찰은 결과 게시를 멈출 뿐 이미 일어난 변경을 되돌리지는 않는다.
- worktree 자동 병합·삭제·push, 원격 공개 서비스용 인증.

