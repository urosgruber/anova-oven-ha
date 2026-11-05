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
door, light) it always shows the same four rows, so it never changes size:

1. Heating mode: the handle's four modes (top, top and bottom, bottom,
   rear with fan). During a cook, this row shows the progress.
2. Temperature (`-  180 °C  +`) and the sous vide toggle.
3. Timer and steam, each `-  value  +`. Hold - or + to change fast.
4. Start. During a cook: Stop (tap twice), and Next stage when a stage
   waits for you.

With a timer, the oven preheats first and the timer starts at
temperature. During a cook, - and + change the temperature and the timer
of the running cook.

## Data

Recipes, history and the current cook are stored in the app's `/data`
folder. Home Assistant backups include it.
