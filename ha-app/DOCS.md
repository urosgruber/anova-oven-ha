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
door, light) it always shows the same five rows, so it never changes size:

1. Heating elements: any one or two of top, bottom and rear (six choices).
   During a cook, this row shows the progress.
2. Temperature: drag the slider, or tap - and +. The toggle next to it
   switches sous vide on (25-100 °C) or off (bake).
3. Steam: drag the light-blue slider (10 % steps). With sous vide on, it
   is 100 % and locked. During a cook, it shows the measured humidity.
4. How the cook ends: until you stop, a timer, or a probe temperature,
   with - and + for the time or the probe target.
5. Preheat and Bake (or Cook, with sous vide on). With Preheat on, the
   oven heats up first, and the cook and its timer start at temperature.
   During a cook: Next stage when a stage waits for you, and Stop (tap
   twice).

During a cook, the temperature slider and - and + change the running
cook's temperature, and - and + change a running timer.

The header shows the door, the probe (orange while plugged in; its
temperature is in the status line), the light, and a wrench. "End by
probe" works only with the probe plugged in.

The wrench opens the maintenance panel in the same space:

- Heating element prep (from the oven's manual): rear 176 °C for 15 min,
  then top and bottom 176 °C for 15 min. Between them, let the oven cool
  and air it, then tap Next stage. Tap Stop at the end.
- Descale: shows if a descale is needed. Start it on the oven: fill the
  tank with descaler and water, press the descale symbol, then Start. The
  card cannot start a descale yet; the command is untested.
- Water tank: empty or OK.

During a cook, the slider and - and + change the running cook's
temperature, and - and + change a running timer.

## Data

Recipes, history and the current cook are stored in the app's `/data`
folder. Home Assistant backups include it.
