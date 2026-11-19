# agent-bridge

[English](README.md)

AI 코딩 도구끼리 일을 주고받게 해 주는 작은 로컬 작업함이에요.
작업을 한 번 적고, **Claude Code**, **Codex**, **Antigravity**(Gemini) 중 누구에게 맡길지 고른 뒤, 결과를 한곳에서 받아요.

> **상태: 초기 버전(0.1.0).** **Windows x64**에서만 확인했어요.
>
> agent-bridge는 개인이 만든 독립 프로젝트예요. Anthropic, OpenAI, Google과 관계가 없고 공식 도구가 아니에요.

> **Gemini를 쓰실 분은 꼭 읽어 주세요.** 개인 Google 계정으로 Gemini를 연결하면 Google 약관 위반이 될 수 있어요. [Antigravity FAQ](https://antigravity.google/docs/faq/)는 다른 프로그램이 Antigravity 로그인을 이용하는 것을 금지하고, 계정이 정지될 수 있다고 안내해요. 다음 버전부터는 Gemini API 키 방식(권장)을 고를 수 있고, 개인 계정 방식은 위험 안내에 동의해야 쓸 수 있어요. 0.1.0은 개인 계정 방식만 지원해요.

## 하는 일

- 작업, 회신, 질문을 내 컴퓨터의 SQLite 작업함(`~/.agent-bridge/bridge.db`)에 기록해요.
- 이미 설치하고 로그인한 CLI로 작업을 실행해요.
  - Codex: `codex app-server`
  - Claude Code: `claude -p`
  - Gemini: Antigravity CLI(`agy`). Gemini API 키와 개인 Google 계정 중 직접 고른 방식으로 연결해요
- 쓸 AI를 직접 골라요. 켜 둔 AI끼리만 작업을 주고받아요.
- 작업마다 받는 도구, 모델, effort를 고를 수 있고, 단계를 이을 수 있어요(예: Codex가 쓰고 Claude가 검토).
- 시도마다 토큰 사용량을 기록해요.
- 원하면 브라우저 대시보드에서 작업을 등록하고 진행 상황을 볼 수 있어요.

작업함 자체는 모델을 부르지 않아요. 실행기가 작업을 실행할 때만 사용량이 생겨요.

## 설치 (Windows x64)

1. [Releases](../../releases)에서 `agent-bridge-win-x64.zip`을 받아 아무 폴더에 풀어요. Node.js가 들어 있어서 따로 설치할 필요가 없어요.

   zip 안의 스크립트에는 코드 서명이 없어서, Windows가 "Windows의 PC 보호" 경고를 띄우거나 파일을 막을 수 있어요.
   압축을 풀기 전에 Release 페이지의 SHA-256 값과 같은지 확인한 뒤 차단을 풀어 주세요.

   ```powershell
   Get-FileHash .\agent-bridge-win-x64.zip -Algorithm SHA256
   Unblock-File .\agent-bridge-win-x64.zip
   ```
2. 쓸 AI CLI(Codex, Claude Code, Antigravity `agy`) 중 하나 이상을 직접 설치하고 로그인해요.
3. `Self Test.cmd`를 실행해요. 모델을 부르지 않고 모의 에이전트로 설치 상태만 점검해요.
4. 찾은 CLI를 확인해요.

   ```powershell
   .\agent-bridge.cmd doctor
   ```

5. 필요하면 설치된 도구마다 짧은 실제 호출을 한 번씩 해서 로그인 상태를 확인해요. 사용량이 조금 들어요.

   ```powershell
   .\agent-bridge.cmd check-connections
   ```

자세한 설치 안내는 압축 파일 안의 `QUICKSTART.ko.md`에 있어요.

## 설정: 쓸 AI와 Gemini 연결 방식

대시보드의 **설정** 탭이나 `settings` 명령으로 바꿔요. 실행 중인 실행기는 중단했다가 다시 시작하면 바뀐 설정이 적용돼요.

```powershell
.\agent-bridge.cmd settings                              # 현재 설정 보기
.\agent-bridge.cmd settings --disable claude-code        # AI 끄기
.\agent-bridge.cmd settings --gemini-auth api-key        # Gemini를 API 키로 연결 (권장)
```

Gemini는 연결 방식을 고르기 전에는 작업을 받지 않아요.

- **`api-key` (권장)**: [Google AI Studio](https://aistudio.google.com/apikey)에서 키를 만들어 사용자 환경변수 `GEMINI_API_KEY`에 넣어요. 쓴 만큼 Google에 따로 요금이 나갈 수 있어요. agent-bridge는 키를 저장하거나 화면에 보여 주지 않아요.
- **`account`**: `agy`에 로그인한 내 Google 계정을 써요. **Google 약관 위반이 될 수 있고** 계정이 정지될 수 있어요(위 FAQ 참고). `--accept-account-risk`나 대시보드의 동의 체크로 위험을 직접 감수한다고 확인해야 고를 수 있어요.
- **`both`**: 두 방식을 모두 허용해요. 평소에는 `--gemini-default`로 정한 방식을 쓰고, 작업에 `"gemini_auth": "api-key"` 또는 `"account"`를 적으면 그 작업만 바꿔요.

AI 도구 로그인은 모두 직접 해요. agent-bridge는 대신 로그인하지 않고, 각 서비스의 약관을 지킬 책임은 사용하는 분께 있어요.

## 안전과 개인정보

- **기본은 읽기 전용이에요.** 쓰기 작업은 실행기를 `--allow-write`로 켜고, 작업의 `write_files`에 고칠 파일을 적어야만 실행돼요. 목록 밖 파일이 바뀐 것을 발견하면 작업을 `blocked`로 멈추고 확인을 기다려요. 미리 막는 장치가 아니라 사후 감지라서, 이미 바뀐 내용을 되돌리지는 않아요.
- **모든 것이 내 컴퓨터 안에서 돌아요.** 사용 통계를 보내지 않고, 자체 서버로 아무것도 보내지 않아요. 모델 호출은 직접 설치한 공식 CLI를 거쳐요.
- **대시보드는 `127.0.0.1`에서만 열리고**, 접속 출처와 세션 토큰을 확인해요.
- **인증정보를 저장하지 않아요.** 로그인은 각 CLI가 관리해요.
- **설정 변경 감시.** 작업 전후로 AI 도구 설정 파일의 **해시값만** 비교해서 예상치 못한 변경을 잡아내요. 파일 내용은 밖으로 보내지 않아요.
- 연결된 AI 도구는 작업 폴더의 파일을 읽을 수 있고, 허용하면 고칠 수도 있어요. 작업 폴더는 신중하게 골라 주세요.

## 알려진 제한

- Windows x64 전용이에요. macOS와 Linux는 확인하지 않았어요.
- 기본값으로 필수인 플러그인은 없어요. `profiles.json`의 `required_plugins`에 적은 플러그인은 모든 프로필에서 켜진 채로 유지돼요.
- Artifact Writer는 선택 사항이에요. 설치돼 있으면 Codex가 문서 파일(`.md`, `.html`, `.json` 등)을 쓸 때 사용하고, 없으면 작업 폴더 안에 직접 써요.
- `profiles.json`과 `image-job.mjs`의 기본 모델 이름은 시간이 지나면 바뀔 수 있어요. 쓸 수 있는 모델로 바꿔 주세요.
- 대시보드에서 작업을 등록하려면 Git과 Git 저장소가 필요해요. 일반 폴더 작업은 CLI로 보낼 수 있어요.
- 기본 검토 체인(`chain.review`)에는 Codex와 Claude Code가 모두 필요해요.
- 작업함은 한 컴퓨터 안에서만 공유돼요.

## 소스에서 실행

Node.js 22.13 이상이 필요해요. npm 패키지는 쓰지 않아요.

```powershell
node portable.mjs doctor
npm test
```

배포용 zip 만들기 (Windows x64, 출력 폴더는 아직 없어야 해요):

```powershell
npm run build:release -- release
```

## 문서

- [docs/reference.ko.md](docs/reference.ko.md): 전체 명령과 옵션
- [docs/common-contract.ko.md](docs/common-contract.ko.md): 공통 작업 계약
- [docs/efficiency.ko.md](docs/efficiency.ko.md): 사용량 기록과 비용 메모

## 후원

agent-bridge는 무료 오픈소스예요. 도움이 됐다면 [talkak.shop](https://talkak.shop)에서 응원해 주세요.

## 라이선스

[MIT](LICENSE)
