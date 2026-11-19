# 외부 공통 업무 계약 사용 안내

공통 계약은 여러 에이전트에 전달할 목표·요구사항·원본·환경·검수 기준을 담은 **외부 JSON 파일**이다. 업무별 역할은 기존 `C:/workflows/agent-workflows.json`에 그대로 유지한다. 계약은 모델·예산·권한을 자동으로 바꾸지 않는다.

시작 예시는 `C:/workflows/bridge-contract.example.json`이다. 실제 프로젝트에 맞게 수정할 템플릿이며, 운영용 업무 계약이나 자동화 실행 트리거가 아니다.

## 1. 계약 작성

```json
{
  "id": "project-common",
  "version": "1",
  "objective": "프로젝트의 공통 목표",
  "requirements": [
    { "id": "REQ-1", "text": "모든 단계에서 지킬 요구사항" }
  ],
  "sources": [
    { "path": "input/source.json", "hash": "<실제 파일의 SHA-256 값>" }
  ],
  "environment": {
    "node": "<실제 host Node 버전>",
    "platform": "<실제 host platform>",
    "arch": "<실제 host arch>",
    "files": [
      { "path": "config/render.json", "hash": "<실제 파일의 SHA-256 값>" }
    ],
    "tools": [
      { "id": "renderer", "path": "<실제 실행파일 경로>", "hash": "<실제 파일의 SHA-256 값>" }
    ]
  },
  "review": {
    "criteria": [
      {
        "id": "CHECK-1",
        "text": "검수할 공통 기준",
        "method": "확인 방법과 필요한 증거",
        "required": true
      }
    ]
  }
}
```

`<…>`는 교체할 자리표시자다. 이 예시를 그대로 제출하지 않는다. 원본·환경·도구 파일의 `hash`는 모두 **`sha256:` 접두사와 64자리 해시** 형식이어야 하며, 해당 파일에서 구한 실제 값을 준비해야 한다.

- `id`, `version`, `objective`는 문자열이다. 요구사항의 `id`와 검수 기준의 `id`는 각각 중복되지 않아야 한다.
- 검수 기준은 하나 이상 필요하다. `required`를 생략하면 `true`다.
- `environment`에서 허용하는 키는 `node`, `platform`, `arch`, `files`, `tools`뿐이다. 각 키는 선택 사항이며, 알 수 없는 키는 거부된다. 도구 항목의 `id`도 선택 사항이다.
- 원본·환경 파일·도구 경로는 절대경로 또는 작업의 `task.cwd` 기준 상대경로다. 폰트와 설정 파일 등 고정해야 할 파일은 `environment.files`에 선언한다.

## 2. 확인하고 전달하기

```powershell
agent-bridge contract-inspect contract.json --repo C:/work/project
agent-bridge send task.json --contract contract.json --workflow C:/workflows/agent-workflows.json --workflow-role ROLE_NAME
agent-bridge send-plan plan.json --contract contract.json --workflow C:/workflows/agent-workflows.json
```

자동 실행은 `agent-bridge run --once`로 처리한다. 직접 받을 때는 `receive --as <agent> --take-tasks`를 사용하고, 직접 회신할 때는 기존 `--acceptance <json>`과 추가 `--contract-receipt <json>`을 사용한다. 실제 영수증 값을 사용하고 환경·입력·선행 회신의 변동을 검사한다. 기존 독립 검수 체인은 전용 실행기를 사용한다.

`ROLE_NAME`은 기존 역할 파일의 실제 역할명으로 바꾼다. `send`의 `--workflow`와 `--workflow-role`은 역할을 적용할 때 사용한다. 모든 명령은 `--db PATH`를 지원한다.

CLI 옵션 대신 작업 또는 계획 JSON의 `contract`에 파일 경로 문자열이나 `{ "file": "contract.json" }`을 넣어도 된다. 옵션과 JSON에 지정한 계약이 서로 충돌하면 오류가 난다.

계약은 문서·계약 해시·출처 경로와 파일 해시를 함께 보관한다. 기존 `task.acceptance`는 유지하고, 해당 단계에 배정된 필수 공통 검수 문구를 추가한다.

## 3. 프로젝트 실행과 단계별 검수

같은 프로젝트 실행에서는 계약을 교체할 수 없다. 후속 요청에서 계약을 생략하면 기존 계약을 상속한다. 의도적으로 변경하려면 **새 `version`과 새 프로젝트 실행 ID**로 구분해 이전 이력을 보존한다. 계약 없는 기존 legacy 업무는 그대로 작동한다.

계획의 계약은 모든 단계가 공유한다. 단계에 다른 계약을 지정하면 거부된다. 계약이 붙은 작업과 단계는 `contract_review_ids`에 이번에 확인할 검수 기준 ID를 직접 적어야 한다. 확인할 기준이 없으면 `[]`를 적는다. 생략하면 거부되며, 기본으로 배정되는 기준은 없다. 그 단계가 확인할 수 없는 필수 기준을 배정하면 `unverified` 회신이 실패로 처리되기 때문이다. 계획 전체에서는 모든 필수 기준을 적어도 한 단계에 배정해야 한다.

내장 독립 검수자는 생산 단계의 선택 범위와 무관하게 모든 공통 검수 기준을 받는다. 적법한 `reject`는 기존 재작업 흐름으로 이어진다. 계획에서 `chain.review`가 켜진 단계는 모든 필수 기준을 맡은 것으로 센다.

### 혼합 검수 (`review.mode: "hybrid"`)

검수자가 볼 수 없는 기준(파일이 실제로 생겼는지, 값이 정확한지)까지 모델에게 맡기면 `unverified`로 돌아와 작업이 실패한다. 혼합 검수는 기준을 둘로 나눈다.

- **프로그램 확인**: `check`가 있는 기준은 브리지가 모델 없이 직접 확인한다. 형식은 `file-exists`(`path`), `file-sha256`(`path`, `expected`: `sha256:` + 64자리), `json-equals`(`path`, `key`: 키 경로 배열, `expected`)뿐이다.
- **판단 확인**: `check`가 없는 기준은 `evidence`에 검수자가 읽을 파일(작업 폴더 기준 상대경로)을 하나 이상 적는다. `requirement_ids`를 적으면 검수자에게 그 요구사항만 보낸다.

```json
"review": {
  "mode": "hybrid",
  "criteria": [
    { "id": "Q1", "text": "결과 파일이 있다", "method": "file-exists",
      "check": { "type": "file-exists", "path": "out/deck.pptx" } },
    { "id": "Q2", "text": "원문 수치가 그대로다", "method": "source-comparison",
      "evidence": ["facts.txt", "out/slide-03.png"], "requirement_ids": ["REQ-1"] }
  ]
}
```

- 모든 기준의 경로는 작업의 `file_refs`나 `write_files`에 있어야 하고, 기준 문구(`text`)는 서로 달라야 한다.
- 생산 작업은 `chain.review`를 켜고 `contract_review_ids: []`로 보낸다. 확인은 검수 단계가 맡는다.
- 프로그램 확인만 있고, 계약 밖 `acceptance` 항목이 없고, 바뀐 파일이 모두 선언된 산출물(`.pptx`·`.docx`·`.xlsx`·`.pdf`·이미지)이면 모델을 부르지 않는다. 필수 확인이 실패하거나 판단 근거 파일이 없어도 모델 없이 `reject`하고 재작업으로 넘긴다.
- 모델 검수자에게는 판단 기준·해당 근거 파일·관련 요구사항만 보내고, 생산자의 요약은 보내지 않는다. 코드·설정이나 선언 밖 경로가 바뀌었을 때만 diff와 변경 목록을 함께 보낸다. 혼합 검수는 매 라운드 새 세션으로 시작한다.
- 회신을 게시하기 직전에 프로그램 확인을 다시 실행해, 그사이 파일이 바뀌었으면 게시하지 않는다.
- `mode`를 잘못 쓰거나 `hybrid`가 아닌 계약에 `check`·`evidence`를 적으면 무시하지 않고 거부한다.

## 4. 전달·응답 검증과 영수증

원문과 조건은 canonical JSON으로 손실 없이 직렬화하고, 실제 도구에 보낼 packet과 대조한다. 어댑터별 실제 전달 텍스트의 `CONTRACT_JSON` 또는 구조화된 packet에는 같은 봉인 계약, 검수 ID, 환경 영수증, 해당 단계의 정확한 `goal`·`acceptance`·`sandbox`·`write_files`가 포함된다. 프로필 필터로 계약을 누락할 수 없다.

응답에는 공통 `contract_receipt`가 요구된다. Codex의 `outputSchema`와 Claude/Gemini의 `--json-schema`에 이를 포함하며, 최종 응답에도 영수증을 보존한다.

영수증의 주요 필드는 다음과 같다.

- `contract_hash`, `environment_hash`: 적용한 계약과 환경의 식별값
- `requirement_ids`: 전달된 요구사항 ID 목록
- `review`: 각 `criterion_id`에 대한 `result`와 문자열 `evidence`

`result`는 `pass`·`fail`·`unverified`다. `evidence`에는 판단 근거나 확인하지 못한 이유를 적는다. 필수 기준이 미확인인 상태는 성공 처리하지 않으며, ID나 해시가 누락·변경된 응답도 성공 처리하지 않는다.

운영 상태에서는 `contract_environment`, `contract_delivery`, `contract_response`와 `contract_raw_reply`를 확인할 수 있다. 전달 기록에는 검증 여부와 계약·환경·단계·전송 내용 해시, 요구사항·검수 ID가 남는다. 원본 응답과 진단도 런타임 영수증에 보존된다. 원본 응답 기록은 실행기별로 지원 필드가 다를 수 있다. 기존 작업 결과를 재사용할 때는 내부 검증 이력과 동일한 계약·환경 키가 필요하며, 이전 증거의 재사용은 모델이 새로 검사했다는 뜻이 아니다.

이 검증은 **전달 내용과 응답 형식의 일치**를 확인한다. 모델이 의미를 완전히 이해했거나 모든 사실을 올바르게 판단했다는 보장은 아니다.

## 5. 환경 검증의 범위

환경 검증은 선언한 host의 Node 버전·platform·arch와 원본·도구·폰트·설정 파일 해시를 대상으로 한다. 같은 프로젝트·계약은 공통 기준 환경 해시를 사용하며, 회신을 작업함에 저장하기 직전에도 환경을 다시 검증한다.

`environment.tools`로 공통 도구 체계를 선언하면 등록 프로그램이 실제 선택한 실행파일과 추적 코드의 해시도 대조한다. 숨은 import 의존성까지 검증하려면 해당 파일도 선언해야 한다.

선언한 디렉터리에 중첩 링크가 있으면 실제 대상 파일을 명시해야 검증할 수 있다.

이는 임의의 모델 명령이 항상 같은 렌더러를 사용했다거나, 서로 다른 공급자의 내부 런타임이 같다는 보장이 아니다. 계약은 OS 권한을 확장하거나 `--allow-write` 요건을 없애지 않으며, 게시 권한도 부여하지 않는다.

## 6. 확인된 실측과 한계

2026-11-05 격리 실측에서는 오케스트레이터가 실제 회신을 다음 요청에 인계해 다음 두 경로의 총 6방향을 시험했다.

- Codex → Gemini → Claude → Codex
- Codex → Claude → Gemini → Codex

모든 방향에서 요청·응답·ACK가 성공했다. 동일한 계약 해시·환경 지문, 요구사항 ID와 검수 결과를 확인했으며, `SKU A-17`, `0.35 kg`, nonce·계산 및 직전 회신 확인을 포함했다. 현재 자동화 시험은 호환성 시험을 포함해 142개가 통과했다.

이 결과는 실제 산출물의 빌드·렌더·시각 품질, 숨은 의존성 선언의 완전성, 모델의 이해나 의미론적 완전성을 시험한 결과가 아니다.