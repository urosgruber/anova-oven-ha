# Anova Oven

This app runs the Anova Precision Oven v1 with no Anova cloud. The oven
connects to this app instead of `iot-prod.anovaculinary.io`.

## How the oven reaches the app

1. The DNS server answers `iot-prod.anovaculinary.io` with the IP address
   of this Home Assistant host.
2. The oven always connects to port 443. Home Assistant itself uses 443, so
   the app listens on **4443**.
3. A destination-NAT rule on the gateway changes the port from 443 to 4443
   for the oven's IP address only. Everybody else still reaches Home
   Assistant on 443.

## Home Assistant

With MQTT on (the default), the app creates the **Anova Oven** device. The
Supervisor gives the app its MQTT login, so you do not create a user.

The sidebar page **Oven (debug)** is the server's built-in web page. Only
admins see it. Use the dashboard card for daily cooking.

The app runs two programs. The **server** is the same as upstream
(anova-oven-rs): it connects the oven and creates most entities. The
**adapter** adds what only the dashboard card needs: the "Recipes" and
"Cook stages" sensors, and the save and delete commands for presets. It
uses the server's API inside the app and its own MQTT topics under
`anova/oven/ha/`. If the adapter stops, the app starts it again after
15 s. Until then, the two sensors are unavailable, and the oven works as
usual.

## Dashboard card

The app installs its own dashboard card at every start. It copies the card
to `/config/www/anova-oven/` and registers the resource
`/local/anova-oven/anova-oven-card.js?v=<version>`. You need no HACS. After
an app update, reload the browser page once.

Add the card to a dashboard:

```yaml
type: custom:anova-oven-card
title: Oven
```

The oven never stops by itself: after the last timer, it holds the
temperature until you tap Stop. With **Auto stop** on (the default), the
App stops it when the last timer ends, also for a cook started on the
oven. Turn it on or off in the card's cog panel, or with the "Auto stop"
switch of the Anova Oven device.

### Safety limit

The App stops a dry cook that nothing ends after 4 hours. "Nothing ends"
means one of these:

- The step has no timer and no probe target ("until you stop").
- The last timer ended, and the oven holds the temperature (Auto stop
  off).

The clock starts again for each new step. Sous vide has no limit, because
a sous vide cook can run 24 hours or more. A cook with a timer has no
limit while its timer runs. To cook longer, set a timer. Change the hours
with the `safety_limit_hours` option on the App's Configuration tab. `0`
turns the limit off. The limit works only while MQTT is on. A restart of
the App starts the clock again. If the oven does not take the stop, the
phones get a message, and the App tries again every 5 minutes.

### Start later

The App can start a cook later. The card does not show this yet. Use the
Anova Oven device in Home Assistant:

- Choose the recipe with the "Recipe" select. Then set "Start in minutes"
  and press "Start in", or set "Start at time" (`HH:MM`) and press
  "Start at".
- "Scheduled recipe" and "Scheduled start" show the waiting cook.
- "Start scheduled cook now" starts it at once. "Cancel scheduled start"
  cancels it.

A scheduled cook starts with nobody at the oven. So everyone gets a
notification when a cook is scheduled. The safety limit and the
emergency power cut work for a scheduled cook too. If another cook or
a descale runs at the start time, the App drops the scheduled cook. If
the oven is offline at the start time, the App waits up to 10 minutes,
then drops the cook. Each time, everyone gets a notification. A restart
of the App keeps the scheduled cook.

## Notifications

The App sends the oven's events to phones with the Home Assistant
Companion app:

| Event | Notification |
|---|---|
| Preheat done | "Preheat done. The oven is at temperature." |
| A step without preheat reaches its temperature | "The oven is at 200 °C." |
| The water tank is empty during a steam or sous vide step | "The water tank is empty. Fill it to keep the steam going." |
| A cook is set to start later | "Scheduled cook. The oven starts by itself at 16:30. To cancel, use Cancel scheduled start on the Anova Oven device." |
| A scheduled cook cannot start | "The scheduled cook did not start. Check the oven. (…)" |
| A step starts | "Step 2 of 3 started: …" |
| A step waits for you | "Step 2 waits for you. Tap Start step 2." |
| The last timer ends | "Timer done. The oven stopped." (with Auto stop) |
| The cook stops | "The cook stopped." |
| The safety limit stops the cook | "Safety stop: the oven ran 4 h with no timer, so the App stopped it." |
| Auto stop or the safety limit cannot stop the oven | "The App could not stop the oven. Stop it on the oven." |
| The oven goes offline during a cook | "The oven went offline during a cook. It may still run." |
| A part of the oven fails or overheats | "The oven reports a fault. Fan failed. Stop the oven and check it." |

"Reached its temperature" means within 2 °C of the target (0.5 °C in sous
vide). It comes once per step. When the door opens and the temperature
falls, it does not come again. "The water tank is empty" also comes once
per step.

A fault comes once per fault and goes to everyone. The oven reports
these faults: a failed heating element, triac (the switch for the
heating elements), fan, steam boiler, evaporator or lamp; an overheated
boiler, evaporator, oven top or oven bottom; and a lost link to the
handle display. The "Problem" sensor of the Anova Oven device is on
while a fault lasts. Its `faults` attribute names them.

A cook started from the dashboard card notifies the person who started
it. A cook started on the oven notifies everyone. A person's phones are
the phones in that person's "Track device" list (Settings → People).
Turn notifications off with the `notify` option on the App's
Configuration tab.

If the oven hangs on a smart plug (for example a Shelly), the card can
switch it and show its power draw. Add the plug's entities:

```yaml
type: custom:anova-oven-card
title: Oven
power_switch: switch.oven_plug
power_sensor: sensor.oven_plug_power
power_idle_w: 20   # optional: the most an idle, cool oven draws
```

The card never cuts power during a cook:

- Turn on: when the plug is off. It replaces Bake, and needs one tap.
- Turn off (in the cog panel): only when the oven is idle. It needs two
  taps.
- Restart (in the cog panel): only when the oven is offline and the plug
  draws no more than `power_idle_w`. A higher draw means a cook may
  still run. The plug goes off for 10 seconds,
  then on. This often brings the oven back on the Wi-Fi. Keep the page
  open for those 10 seconds: the card switches the plug back on.

### Emergency power cut

The App can turn the plug off when it cannot stop the oven in a normal
way. It always asks first. A cut is the last resort: it never replaces a
normal stop.

Set the plug on the App's Configuration tab (the card's settings are
separate):

- `power_switch`: the plug's switch, for example `switch.oven_plug`.
  Empty means no emergency power cut.
- `power_sensor`: the plug's power sensor, for example
  `sensor.oven_plug_power`. Optional, but recommended.
- `power_cut_minutes`: how long the App waits for an answer before it
  turns the plug off by itself. The default is 60. `0` means the App
  never turns the plug off by itself; it only asks.

The `notify` option must be on. The alarm starts in two cases:

- Auto stop or the safety limit cannot stop the oven. The alarm starts
  at once.
- The oven goes offline during a cook. The App waits 5 minutes first, so
  a short Wi-Fi drop wakes nobody. The alarm starts only if the plug
  reads more than 20 W, which means the oven heats. With no power
  sensor, the App assumes the oven heats.

Everyone gets the alarm, with two buttons:

- "Turn off power": the App turns the plug off at once. On an iPhone,
  you must unlock the phone first.
- "I am here": the alarm ends. You control the oven yourself. No new
  alarm starts until the oven is idle again.

If nobody answers in `power_cut_minutes`, and the oven still heats, the
App turns the plug off. The alarm ends by itself when the oven is back
online, when the oven stops, or when somebody turns the plug off. Every
notification about the alarm replaces the one before it on every phone,
so everyone sees what happened. After a cut, the plug stays off. Turn it
on again from the card when the oven is safe.

The alarm needs Home Assistant and the App. If Home Assistant is down,
no alarm comes. A restart of the App forgets a running alarm.

The card follows Home Assistant's tile card. Under the header (oven state,
door, light) it always shows the same six rows, so it never changes size:

0. Steps: one chip per step. Tap a chip to edit that step with the rows
   below, + to add a step (a copy of the selected one), x on the selected
   chip to remove it. During a cook, the chips show the stages.
1. Heating elements: any one or two of top, bottom and rear (six choices).
   During a cook, this row shows the progress.
2. Temperature: drag the slider, or tap - and +. The toggle next to it
   switches sous vide on (25-100 °C) or off (bake).
3. Steam: drag the light-blue slider (10 % steps). With sous vide on, it
   is 100 % and locked. During a cook, it shows the measured humidity.
4. How the cook ends: until you stop, a timer, or a probe temperature,
   with - and + for the time or the probe target. Tap the value to type
   it: minutes (90), 1h30 or 1:30, or the probe temperature. When the card is
   about 394 px wide or more, steam sits in this row, next to the timer.
5. Preheat and Bake (or Cook, with sous vide on). With Preheat on, the
   oven heats up first, and step 1 and its timer start at temperature.
   For step 2 and later, the left button chooses "Auto" or "Wait"
   (the step waits until you tap Start step N).
   During a cook: Next stage when a stage waits for you, and Stop (tap
   twice).

During a cook, the temperature bar shows the oven's temperature (orange
fill) and the target (white mark); drag the mark or use - and + to change
the target. - and + also change a running timer. "Skip to step N" ends
the current step early; "Start step N" starts a step that waits for you.

Tap the oven icon or the name in the header to open the oven's device
page. Users who are not admins get the oven's info dialog instead,
because they cannot open Settings.

The header shows the door, the probe (orange while plugged in; its
temperature is in the status line), the light, and a cog. An amber dot
on the cog means a descale is needed or the water tank is empty. "End by
probe" works only with the probe plugged in.

The book button (left of the steps) opens the presets in the same space:
start a preset (play), load it into the editor (with Undo), save the
current steps under a name, or delete one (tap twice). Presets are the
app's recipes; the Recipes sensor carries them with their steps. The
"Cook stages" sensor carries the running cook's steps, so every
dashboard shows them, not only the one that started the cook.

The cog opens the maintenance panel in the same space:

- Heating element prep (from the oven's manual), fully automatic: rear
  176 °C for 15 min, a 15-minute cool-down (fan only, vent open), top and
  bottom 176 °C for 15 min, then a cool-down until you tap Stop.
- Descale: shows if a descale is needed. Fill the tank with descaler
  and water first. Then start the descale on the oven (press the descale
  symbol, then Start), or tap Start in the Descale item. The item shows
  only when the oven asks for a descale or runs one. Start and Abort need
  a second tap. The App starts a descale only when the oven is idle and
  the tank has water. Starting and aborting from the card is
  experimental: the oven commands are not tested yet. You must still be
  at the oven for the clear water and the drip tray. During a
  descale, the card shows "Descaling" with about how many minutes are
  left, and Bake is off. A descale takes about 48 minutes: the descale
  (about 38 minutes), then "add clean water", a 9-minute rinse, and
  "empty the drip tray" (under the door). The oven does not send its own
  countdown, so the minutes are an estimate. A descale is not a
  cook: it sends no cook notifications, and the safety limit does not
  stop it.
- Water tank: empty or OK.

During a cook, the slider and - and + change the running cook's
temperature, and - and + change a running timer.

## Log level

The `log_level` option on the App's Configuration tab sets how much the
App writes to its log. Use `info` (the default) for daily use. Use `debug`
only to find a problem: the log then also has the oven's full message once
a minute. That message has the oven's device ID and versions, so remove
it before you share a log in public. Set the option back to `info` after
the test.

## Data

Recipes, history and the current cook are stored in the app's `/data`
folder. Home Assistant backups include it.
