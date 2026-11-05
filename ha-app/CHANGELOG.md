# Changelog

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
