# Changelog

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
