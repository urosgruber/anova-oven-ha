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
   switches sous vide on (25-100 °C, steam 100 %) or off (bake).
3. How the cook ends: until you stop, a timer, or a probe temperature,
   with - and + for the time or the probe target.
4. Steam (- and +), and the preheat toggle. With preheat on, the oven
   heats up first and the cook (and its timer) starts at temperature.
5. Start. During a cook: Stop (tap twice), and Next stage when a stage
   waits for you.

During a cook, the slider and - and + change the running cook's
temperature, and - and + change a running timer.

## Data

Recipes, history and the current cook are stored in the app's `/data`
folder. Home Assistant backups include it.
