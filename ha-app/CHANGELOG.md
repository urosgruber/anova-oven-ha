# Changelog

## 0.25.1

- Fix: after a Home Assistant restart, the phone messages could stop for
  good. The notifier waited without a time limit for a Core that did not
  answer. Now every wait has a limit: 30 s for the login and 60 s for a
  quiet connection, then a ping. With no answer, the notifier stops and
  the app starts it again after 15 s. With the emergency power cut on,
  the ping runs at each 30 s alarm check.
- A closed connection now logs "Home Assistant closed the connection",
  not a JSON error.

## 0.25.0

The parts for Home Assistant only move out of the server into a new
program, the **adapter**. The server is now closer to upstream, so each
upstream update is easier to merge. You see no change in the card.

- New sensor: "Cook stages", the running cook's steps (diagnostic). The
  "Current recipe" sensor no longer has the steps.
- The "Recipes" sensor stays the same entity. The adapter sends it now.
- The card sends the preset save and delete commands to the adapter
  (`anova/oven/ha/cmd/…`). After the update, reload the browser page
  once: an old card in an open page cannot save or delete presets.
- If the adapter stops, the app starts it again after 15 s.

## 0.24.0

The server follows the newest upstream version. Upstream merged two
changes from this App: stable stage times, and the web page behind a
path prefix.

- The time left and the stage start no longer jump between oven reports.
- The stage start is empty when the App did not see the stage start, for
  example after the oven was offline for more than 1 minute. The card
  then counts from the cook's start.
- The card takes the descale start from the Mode sensor. An HA restart
  during a descale resets the "min left" estimate.
- The App's web page ("Oven (debug)") is safer behind a proxy. It
  refuses a prefix that points to another site.

## 0.23.0

The server follows the newest upstream version. Upstream merged the
MQTT timeout change from this App.

- New: start a cook later ("Start in" minutes, or "Start at" a time).
  Use the Anova Oven device in Home Assistant; the card does not show it
  yet. See "Start later" in the documentation.
- New notifications to everyone: a cook is scheduled, and a scheduled
  cook did not start.
- The App refuses to start a cook while the oven descales.
- The App's web page ("Oven (debug)") can schedule a cook too.

## 0.22.1

- Fix: on the App's web page ("Oven (debug)"), an existing recipe did
  not open, and Save and Delete failed. The page asked for a wrong
  address.

## 0.22.0

The server follows the newest upstream version. Upstream merged the
four changes from this App (descale, faults, MQTT client ID, debug log)
and fixed one bug in them.

- Fix: before the oven's first report, the Problem and Firmware entities
  made template errors in the Home Assistant log.
- A preheat and the cook after it now count as one step everywhere: the
  Stage sensor, the card and the notifications. A recipe with a preheat
  no longer shows "step 2 of 3" for what the card shows as step 1.
- Card: during a preheat, the Next button says "Skip preheat" (or "Start
  cooking" when the cook waits for you).
- Notifications: a preheat that waits for you says "Preheat done. Step 1
  waits for you." A note on the waiting step is added to the text.
- Some entity names say "step" instead of "stage" (for example "Step",
  "Next step"). The entity IDs stay the same.
- From upstream: a step that holds until you go on, the whole running
  recipe on the App's web page, and copy a recipe from its page.

## 0.21.0

- Emergency power cut through a smart plug. Set `power_switch` (and
  `power_sensor`) on the App's Configuration tab. When the App cannot
  stop the oven, or loses the oven during a cook while it heats, everyone
  gets an alarm with "Turn off power" and "I am here". If nobody answers
  in `power_cut_minutes` (default 60, 0 = never), the App turns the plug
  off. See "Emergency power cut" in the docs.

## 0.20.0

- Card: start or abort a descale from the maintenance panel (cog). The
  Descale item shows only when the oven asks for a descale or runs one.
  Start and Abort need a second tap. Experimental: the oven commands
  are not tested on a real oven yet.
- The App starts a descale only when the oven is idle and the water
  tank is not empty.

## 0.19.2

- Fix: the "Visit" link on the device page did not open. It now opens
  the App's page from the sidebar ("Oven (debug)").

## 0.19.1

- Card: tap the oven icon or the name to open the oven's device page. A
  user who is not an admin cannot open Settings, so that user gets the
  oven's info dialog instead.
- Device page: a "Visit" link opens the App's web page.
- Device page: entities that showed HA's generic icon now have their own
  icons.

## 0.19.0

The server now follows the new upstream version, which has a license
(MIT OR Apache-2.0). The App, the card and its tests are MIT.

- New from upstream: a one-step manual cook with its own entities in HA
  ("Manual cook" sensor, "Start manual" button, and numbers and selects
  for its settings). The dashboard card does not need them.
- New from upstream: in the web page's recipe editor, a recipe's last
  step can turn the oven off at its end. Auto stop then leaves that cook
  to the recipe, so the oven gets only one Stop.
- HA shows the oven temperatures in whole degrees. The card still shows
  sous vide in 0.1 °C.
- The "Set timer" number never shows less than 1 minute.

## 0.18.0

- New: the App reads the oven's fault flags. Before, it ignored them. A
  failed heating element, triac, fan, boiler, evaporator or lamp, an
  overheated part, or a lost link to the handle display now:
  - turns on the new "Problem" sensor (its `faults` attribute names them),
  - shows "Oven fault: …" in red in the card,
  - sends "The oven reports a fault. …" to every phone, once per fault.
- New: during sous vide, the card warns when the oven cannot wet the wet
  bulb. Then the sous vide temperature may be wrong.
- New: the "Firmware" sensor shows the oven's firmware version.

## 0.17.3

- During a descale, the card shows about how many minutes are left, for
  example "Descaling · about 20 min left". The oven does not send its
  countdown, so the card uses 48 minutes: the length of one measured
  descale with fast water and tray changes.
- Fix: after an App restart during a descale, the card showed a wrong
  start time. Now it shows only "Descaling".

## 0.17.2

- New option `log_level` (info or debug). With debug, the App log has
  more detail, and the oven's full message once a minute. The default is
  info, and then the oven's full message is not in the log.

## 0.17.1

- While the oven is in a mode the App does not know (for example a
  descale), the App log shows the oven's full message once a minute. This
  helps to find the descale countdown that the oven shows on its display.

## 0.17.0

- A descale is no longer a cook. Before, the card showed "Unknown" with a
  Stop button, and the App could send cook notifications or a safety stop.
- The card shows "Descaling since 08:34" while the oven descales. Bake is
  off, and the card does not turn off the smart plug.

## 0.16.0

Fixes from a code review.

- Safety limit: it keeps working while the MQTT broker is away. Before,
  the App waited for the broker, and the limit did not run.
- At start, the App waits up to 5 minutes for the MQTT broker. Before, it
  turned MQTT off for the whole run when the broker started later, and
  the safety limit and Auto stop were off.
- When the App cannot stop the oven (Auto stop or the safety limit), the
  phones get a message, and the App tries again every 5 minutes.
- A safety stop of a cook that holds after its timer now sends the
  "Safety stop" message too.
- The safety limit now also covers a preheat that waits for you, and it
  ignores the timer of the next step.
- "The water tank is empty" now comes for steam steps too, not only for
  sous vide. It comes once per step and goes to the person who started
  the cook.
- After an App restart during a cook, the App no longer sends "The oven
  is at 200 °C" again to every phone.
- An oven set to °F gets "The oven is at 400 °F."
- Card: tapping the running timer shows the time left. Leaving the field
  without a change no longer restarts the countdown.
- Card: "1.30" in the timer field is refused, because it can mean 1 h 30
  or 1 min 30. Type 1:30 or 1m30s.
- Card: the progress bar is right for timers with seconds.
- Card: "Done" stays during the hold, also after a later notification.

## 0.15.3

- The timer on the card ticks evenly, one second at a time. Before, it
  sometimes showed the same second twice or skipped one. This was true
  for the countdown and for the count-up of a cook with no timer.

## 0.15.2

- A cook started on the oven: the card counts up from the start of the
  step, the same as the oven's display. Before, it counted from the
  start of the cook, so the preheat time was added.
- After the oven's own preheat, the card says "Cooking". Before, it said
  "Preheating" for the whole cook when the step had no timer.

## 0.15.1

- The timer also takes hours, minutes and seconds as 3:30.40 (3 hours
  30 minutes 40 seconds). 3:30 is still 3 hours 30 minutes.

## 0.15.0

- New notification: "The oven is at 200 °C." It comes when a step
  without preheat reaches its temperature, once per step.
- New notification: the water tank is empty during a steam or sous vide
  step.
- Safety limit: the App stops a dry cook that nothing ends after 4 hours.
  This is a step with no timer and no probe, or a cook that holds the
  temperature after its last timer. Sous vide has no limit. Change the
  hours with the new `safety_limit_hours` option; `0` turns it off.
- The timer takes seconds: type 3m30s, 3m30, 3.5 or 210s. 1:30 is still
  1 hour 30 minutes.
- The progress bar no longer jumps back and forth during a timer. The
  App kept moving the end time between two reports from the oven.

## 0.14.0

- Notifications on your phone (Home Assistant Companion app): preheat
  done, a step starts, a step waits for you, timer done, the cook stopped,
  and the oven offline during a cook. A cook started from the card
  notifies the person who started it. A cook started on the oven notifies
  everyone. Turn them off with the new `notify` option.
- Play in the presets now starts the preset's steps directly, the same way
  as Bake / Cook.

## 0.13.0

- Auto stop: the App stops the oven when the last timer of a cook ends.
  Without it, the oven holds the temperature until you tap Stop. It works
  for every cook, also one started on the oven. A cook with no timer runs
  until you stop it, as before. Turn it on or off in the cog panel, or
  with the new "Auto stop" switch in Home Assistant. It is on by default.
- With Auto stop on, the progress row says "Stops 16:40" on the last step.
- A cook with no end counts up: the timer row shows how long the cook has
  run, for example "12:34 in", and the progress row shows "Since 16:20".
- Sous vide: - and + change the temperature by 0.1 °C. During a sous vide
  cook, the temperature row shows the wet-bulb temperature and the step's
  target, for example "55.4 → 56.5 °C".
- The cog panel shows the descale status in its title row, so the panel
  has room for Auto stop.

## 0.12.4

- The temperature's - and + change it by 1 °C (was 5 °C), also during a
  cook. Use the slider for big changes. With sous vide on, the step stays
  0.5 °C.
- When a timer ends, the card keeps the timer selected and shows "Done".
  Before, it switched to "until you stop". The progress row says "Done ·
  holding 100 °C", because the oven keeps the temperature until you tap
  Stop.
- During a cook, the steam row shows the running step's steam setting.
  Before, it showed the oven's humidity reading, which stays at 0 % in
  the steam mode that the card uses.
- The progress row shows when the step ends, for example "Ends 15:35".
  The time left stays in the timer row, so it no longer shows twice.
- The power draw in the status line is always visible. A long program
  name now shortens with "…" instead of the power draw.
- The progress bar moves smoothly. Before, it jumped back and forth,
  because the end time from the App moved by up to a second at every
  update.

## 0.12.3

- The cog panel shows a water tag only when the oven reports its tank as
  empty. Before, it showed "OK" at other times, but the oven only reports
  "empty" or "not empty", and nobody has tested when it says "empty".
- Descale shows "unknown" while its sensor is unavailable, for example
  with the oven offline. Before, it showed "not needed".

## 0.12.2

- The cog panel fits again without scrolling. Each item has one line of
  text at most. Descale and the water tank share one item. The descale
  steps show only when a descale is needed. Hover an item for the full
  text.

## 0.12.1

- "Turn off" in the cog panel works whenever the oven is idle. 0.12.0
  also required a temperature below 50 °C, because we assumed that the
  oven cools itself with its fan after a stop. It does not.

## 0.12.0

- Smart plug support (optional). Add `power_switch` and `power_sensor` to
  the card's settings (see the documentation):
  - The status line shows the power draw, for example "Idle · 23 °C · 2 W".
  - "Turn on" replaces Bake when the plug is off.
  - The cog panel can turn the plug off when the oven is idle and below
    50 °C, and restart it when the oven is offline and draws almost
    nothing. The card never cuts power to a hot oven.
- Offline after a cook: the card says "Offline since 12:40" and "Was
  cooking at 176 °C · it may still run". The oven keeps cooking without a
  connection, so the card no longer looks idle.
- Offline: the door and probe icons are greyed out, because the card
  does not know their state.
- When the App itself is not running, the card says so, and no longer
  tells you to check the oven.

## 0.11.3

- The target mark in the temperature bar stays fully visible at the ends,
  for example at 25 °C during a cool-down.
- "Until you stop" has no - and + next to it, so the full text fits.

## 0.11.2

- Fix the timer's - and + during a cook. They now add or take 5 minutes
  from the time left. Before, they used the step's total time, and the
  oven restarts its countdown from the value it gets. So with 6 minutes
  left of 15, + set 20 minutes left, and - set 10 minutes left.

## 0.11.1

- During a cook, every phone and browser shows the stage temperatures in
  the step chips. Before, only the device that started the cook showed
  them. The app now sends the running cook's stages to Home Assistant, as
  attributes of the "Current recipe" sensor.

## 0.11.0

- Heating element prep runs by itself: rear 176 °C for 15 min, a
  15-minute cool-down with the vent open, top and bottom 176 °C for
  15 min, then a cool-down until you tap Stop. The oven no longer holds
  176 °C at the end. (Not tested on a real oven yet: watch the first run.)
- Multi-step cooks: "Skip to step 2" is available while a later step
  exists. When a step waits for you, the button turns orange and says
  "Start step 2", and the progress row says "Step 2 waits for you".
- Shorter texts: the status line shows only the program's name. The
  progress row shows the step and the time left, for example "Step 1/4"
  and "12:17 left". New programs get short names, for example
  "220 → 180 °C · 2 steps".
- During a cook, the temperature bar shows the oven's temperature as the
  orange fill and the target as a white mark, with "143 → 176 °C".
- During a cook, the step chips show each stage's temperature (and a
  snowflake for a cool-down) when this phone or browser started it.
- The button next to Bake / Cook is as wide as the three buttons above it.
  Its labels are Preheat, Auto and Wait.

## 0.10.3

- Steam now really sits next to the timer on cards of about 394 px and
  more. 0.10.0 to 0.10.2 used a CSS rule that does not work inside Home
  Assistant's card frame, so steam always kept its own row.

## 0.10.2

- The steam label is centred in its bar again.

## 0.10.1

- Steam now sits next to the timer from a card width of about 394 px (was
  about 484 px). Only very narrow cards keep steam in its own row. Long
  steam labels end with "…" instead of overflowing.

## 0.10.0

- Less orange. Orange now means heat only: the temperature, Bake / Cook,
  Preheat, and the progress during a cook. Light blue means water. A
  selected mode, end type or step is a raised neutral chip.
- Type the timer: tap its value and enter minutes (90), 1h30 or 1:30. Tap
  the probe value to type the probe temperature. On a running cook, the
  typed time sets the running timer.
- Wide cards (about 460 px and more) put steam next to the timer, so the
  card is one row shorter. Narrow cards and phones keep steam in its own
  row.
- An amber dot on the cog when a descale is needed or the water tank is
  empty.
- Save in the presets uses Home Assistant's main colour.

## 0.9.2

- The button next to Bake / Cook has a fixed width, so Bake / Cook keeps
  its size when you switch steps. Its labels are shorter: Preheat, Auto
  start, Wait for me.

## 0.9.1

- The cog no longer shows as selected while the presets are open.

## 0.9.0

- Presets: the book button at the left of the steps row opens them.
  - Play starts a preset at once.
  - Load puts its steps into the editor, with Undo for 15 seconds.
  - Save stores the current steps under a name. Saving under an existing
    name replaces that preset after a second tap.
  - Delete needs a second tap.
- Presets are the app's recipes, so all phones and the debug page share
  them. New sensor "Recipes" carries them with their steps.

## 0.8.0

- Steps: a row of step chips above the controls. Tap a chip to edit that
  step, + to add a step (a copy of the selected one), and x on the
  selected chip to remove it. Up to 8 steps.
- For step 2 and later, the button next to Start chooses if the step
  starts by itself or waits until you tap Next stage. Step 1 keeps
  Preheat there.
- During a cook, the chips show the stages: done ones ticked, the running
  one highlighted.
- The maintenance button is a cog.
- Your last setup becomes step 1.

## 0.7.2

- Fix taps that did nothing, so that a button needed two or three taps.
  The card rebuilt itself whenever any entity in Home Assistant changed,
  and a rebuild between press and release dropped the tap. Now it rebuilds
  only when an oven entity changes, and never while a finger or mouse
  button is down.
- The greyed-out probe option says why: plug the probe in to use it.

## 0.7.1

- Add this changelog. Home Assistant shows it on the app page and in the
  update dialog.

## 0.7.0

- Steam is a light-blue slider in its own row, in 10 % steps. With sous
  vide on, it shows 100 % and is locked. During a cook, it shows the
  measured humidity.
- Preheat moved next to Bake / Cook.
- The fan modes have no box: rear is a plain fan, and rear + top or rear +
  bottom add a short line above or below it.
- Releases are faster: a change to the card alone no longer rebuilds the
  server.

## 0.6.0

- Probe status in the header: orange while the probe is plugged in. Its
  temperature is in the status line. "End by probe" needs the probe.
- Preheat is a labelled button.
- The start button says Bake, or Cook with sous vide on.
- Maintenance panel (the wrench): heating element prep, descale status
  and how to start a descale on the oven, and the water tank.

## 0.5.0

- Temperature slider with - and + at the ends.
- All six heating element choices: top, top + bottom, bottom, rear,
  rear + top, rear + bottom.
- Choose how a cook ends: until you stop, a timer, or a probe target.
- Preheat as its own choice.

## 0.4.0

- The card follows Home Assistant's tile card: rows 42 px high, and the
  card keeps its size in every state.
- Sous vide is an on/off toggle next to the temperature.

## 0.3.0

- The card is laid out like the oven's handle: heating mode, temperature,
  timer and steam.

## 0.2.0

- The app installs its dashboard card itself. HACS is not needed.
- Start a manual cook from the card: temperature, elements, sous vide,
  steam and timer.

## 0.1.1

- Fix thousands of template errors in the Home Assistant log while the
  oven is offline, and the "Set timer" range error.

## 0.1.0

- First version: the server runs as a Home Assistant app. The oven
  connects to it instead of the Anova cloud, and Home Assistant gets the
  Anova Oven device over MQTT.
