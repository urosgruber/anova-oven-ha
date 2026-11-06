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

The header shows the door, the probe (orange while plugged in; its
temperature is in the status line), the light, and a cog. An amber dot
on the cog means a descale is needed or the water tank is empty. "End by
probe" works only with the probe plugged in.

The book button (left of the steps) opens the presets in the same space:
start a preset (play), load it into the editor (with Undo), save the
current steps under a name, or delete one (tap twice). Presets are the
app's recipes; the Recipes sensor carries them with their steps.

The cog opens the maintenance panel in the same space:

- Heating element prep (from the oven's manual), fully automatic: rear
  176 °C for 15 min, a 15-minute cool-down (fan only, vent open), top and
  bottom 176 °C for 15 min, then a cool-down until you tap Stop.
- Descale: shows if a descale is needed. Start it on the oven: fill the
  tank with descaler and water, press the descale symbol, then Start. The
  card cannot start a descale yet; the command is untested.
- Water tank: empty or OK.

During a cook, the slider and - and + change the running cook's
temperature, and - and + change a running timer.

## Data

Recipes, history and the current cook are stored in the app's `/data`
folder. Home Assistant backups include it.
