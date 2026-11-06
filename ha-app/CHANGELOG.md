# Changelog

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
