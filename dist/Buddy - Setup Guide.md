# Buddy: setup guide

Buddy is a desktop work companion for Windows. It keeps track of your tasks and reminders, nudges you at the right moments through a small character in the corner of your screen, records your updates and blockers, and writes your daily stand-up and weekly summary for your manager.

## 1. Install (about 2 minutes)

Pick **one** of the two files you were sent:

- **Buddy-Setup-1.0.4.exe** (recommended): double-click it and follow the steps. It adds Buddy to the Start menu and desktop, and you can uninstall it from Windows Settings â†’ Apps.
- **Buddy-Windows.zip** (no install): right-click â†’ **Extract All**, put the **Buddy** folder somewhere permanent (for example `C:\Users\<you>\Buddy`, not Downloads or a temporary folder), then double-click **Buddy.exe**.

Windows may show a blue **"Windows protected your PC"** screen because Buddy isn't commercially signed. Click **More info**, then **Run anyway**. You only need to do this once.

## 2. Connect an AI (one time)

Buddy uses an AI to understand what you type or say. Settings opens automatically the first time. Go to **AI connections**, pick a type and click **Add connection**.

**Sign in with an account you already have (no API key):**

| Connection | Works with | Notes |
|---|---|---|
| ChatGPT account | ChatGPT Plus, Pro or Business | About 5â€“10 seconds per reply |
| Claude account | Claude Pro or Max | About 5 seconds per reply |
| Google account (Gemini) | A personal Gmail account (free tier) | Work (Google Workspace) accounts usually aren't supported |

Click **Sign in** on the connection. The first time, Buddy installs a small sign-in tool, which needs **Node.js** (free). If you don't have it, Buddy opens nodejs.org: install the **LTS** version, then click **Sign in** again. Finish signing in in your browser, then click **Test**.

**Or use an API key** (no install needed): choose Claude, OpenAI or Gemini **API key**, paste the key, and click **Test**. Gemini keys are free from aistudio.google.com (with daily limits); Claude and OpenAI keys need credit on console.anthropic.com or platform.openai.com.

You can add several connections. The top one is the **main** connection; the others are backups that Buddy uses automatically if the main one is busy, out of quota or signed out. Use **Make main** to change the order.

Also fill in **your name** and **your manager's name** (used in greetings and reports), then click **Save settings**.

## 3. Allow the microphone (for voice)

The first time Buddy listens, Windows may ask for microphone access. Allow it. In **Settings â†’ Voice**, the **Voice check** shows a live level bar and what Buddy heard. If the bar doesn't move, choose a different **Microphone** there.

## 4. Try it

Type in the chat box, click the character, or say **"Hey Buddy"** followed by what you want:

- "New task from Priya: vendor audit due Thursday 5 pm, high priority."
- Paste your whole weekly plan: Buddy turns each item into a task.
- "Remind me to call the courier at 4 pm." / "Remind me 2 hours before the audit is due."
- "Blocked on the billing migration, waiting for DB access from IT."
- "What's due today?" / "What am I blocked on?" (answered instantly)
- "Focus mode for 25 minutes."
- "Prepare my daily stand-up."

## Everyday use

**Tasks and Reminders tabs.** The left panel has two tabs. **Tasks**: click a task to change its status, due date, priority or progress, log updates and blockers, or delete it. **Reminders**: every reminder in one list (on tasks or standalone), with filters (Upcoming, Today, Repeating, Paused, Past). Use the switch to pause or resume, click to edit, âœ• to delete, and **Add reminder** for a new one.

**The character.** A small companion sits in the corner of your screen. It walks in for reminders (with **Mark done**, **Snooze** and **Open** buttons), checks in on your progress, suggests water and stretch breaks, asks for a wrap-up at the end of the day, and catches you up when you return. Click it to talk. **Drag it** to any corner of any screen. In **Settings â†’ Companion** you can pick a robot, man or woman, or your own image, and change work hours, check-in and break times, and moods (focused Monday, happy Friday, sleepy at night).

**Focus mode** pauses check-ins and breaks (reminders still come through) and shows a countdown. Start it by voice, by clicking the character, or from the tray menu.

**Closing the window doesn't quit Buddy.** It keeps running in the system tray (near the clock, possibly under the **^** arrow), so reminders keep working. To quit fully, right-click the tray icon and choose **Quit Buddy**.

| Action | How |
|---|---|
| Show or hide Buddy from anywhere | **Ctrl + Alt + B** |
| Start talking (when Buddy's window is active) | **Ctrl + Space**, the orb, or the mic button |
| Cancel listening or close a panel | **Esc** |
| Quiet for an hour / focus mode | Right-click the tray icon |

**Manager reports:** click **Daily stand-up** or **Weekly summary** at the top. Buddy writes the report only from what you've logged. Edit it if you like, click **Copy report**, and paste it into email or Teams.

**Start with Windows** (Settings â†’ Windows, on by default): Buddy starts quietly in the tray when you sign in. Reminders that came due while the PC was off appear when you're back, marked "missed while away".

## Your data and privacy

- Tasks, reminders, history and settings are stored only on your PC, in `%APPDATA%\Buddy`. Every change is saved straight away, with a rolling backup copy.
- API keys are encrypted with Windows' built-in protection.
- The wake word and speech-to-text run fully offline. No audio leaves your PC.
- Only your messages and a summary of your current tasks and reminders are sent to the AI you connected. Common questions like "what's due today?" are answered on your PC without any AI.
- **Back up to file / Restore from file** in Settings saves everything to one file. Doing this weekly is a good habit.

## Troubleshooting

- **No reminder pop-ups:** make sure Buddy is in the tray. If you chose **Quit**, it isn't running.
- **"Not signed in" / "isn't working" on a connection:** click **Sign in** again, then **Test**. For API keys, paste the key again.
- **"Usage limit reached":** your plan's limit for now. Add a second connection as a backup, or try again later.
- **Buddy doesn't hear "Hey Buddy":** open **Settings â†’ Voice check**. If the bar doesn't move, pick another microphone. If it hears you but no âœ“ appears, set **Wake word sensitivity** to **Relaxed**. You can always click the character or press **Ctrl + Space** instead.
- **No internet:** the tasks, reminders and instant answers still work. Only AI replies and AI-written reports need a connection.

## Uninstall

- **Installed with Buddy-Setup:** Windows Settings â†’ Apps â†’ **Buddy** â†’ Uninstall.
- **Zip version:** quit Buddy from the tray, untick **Start with Windows** first if you want, then delete the Buddy folder.

To also remove your data, delete `%APPDATA%\Buddy`.
