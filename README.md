# Buddy

A desktop work companion for Windows. Buddy tracks tasks and reminders, nudges you through a small
on-screen character, records progress updates and blockers, and writes your daily stand-up and weekly
summary for your manager.

- **Tasks and Reminders** tabs: create, edit, pause and delete; standalone reminders or reminders on tasks.
- **Chat and voice** ("Hey Buddy", offline speech recognition): add tasks, paste a weekly plan, set reminders,
  log blockers. Common questions ("what's due today?", "focus mode") are answered instantly without AI.
- **On-screen companion**: robot, man, woman or your own image; reminders, focus check-ins, water and stretch
  breaks, end-of-day wrap-up, daily moods, focus mode; drag it to any screen corner.
- **AI connections**: sign in with a ChatGPT, Claude or Google account (via their command-line tools), or use
  Claude / OpenAI / Gemini API keys, with automatic fallback between them.
- Data stays on the PC (`%APPDATA%\Buddy`), saved on every change with a rolling backup.

Built with Electron. See [BUILD.md](BUILD.md) to run from source, test and package, and
[dist/Buddy - Setup Guide.md](dist/Buddy%20-%20Setup%20Guide.md) for end users.

    npm install
    npm start      # run
    npm test       # 58 backend tests
