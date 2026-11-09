# Manual tests on a real oven

These tests need a real oven, so CI cannot run them. Do them at a normal
cook. Mark each test with the date and the App version when it passes. If a
test fails, take a screenshot of the card and copy the App log.

## Tests for a normal cook

| Test | What to do | Expected result | Passed |
|---|---|---|---|
| Running timer | During a cook, tap the timer on the card. Leave the card and come back. | The countdown continues. It matches the oven display. | |
| Temperature reached | Start a cook with a set temperature. Wait. | You get the "temperature reached" notification one time. | |
| Count-up | Start a cook without a timer. | The count-up on the card matches the oven display. | |

## Tests for cases that come up rarely

Do these tests when the case happens in normal use.

| Test | When it happens | Expected result | Passed |
|---|---|---|---|
| Empty water tank | A steam step runs and the tank is empty. | The card shows a warning. You get a notification. | |
| Preheat that waits | A recipe preheats and then waits for you to put the food in. | The card shows that the oven waits for you. You get a notification. | |
| Probe end | A cook ends when the probe reaches its temperature. | The card shows the probe temperature. The cook ends and you get the "done" notification. | |
| Oven fault | The oven reports a fault flag. | The Problem sensor turns on. The card shows "Oven fault: …". All users get the fault notification one time. | |
| Wet bulb is dry | The wet bulb sensor has no water. | The card shows "Wet bulb is dry: the temperature may be wrong". | |
| Descale from the card (0.20.0) | The oven asks for a descale. Fill the tank with descaler and water, then tap Start twice in the cog panel. | The oven starts its descale program. Abort (two taps) stops it. If not, the App log shows the oven's answer (set `log_level: debug` first). | |
| Descale | The oven asks for a descale and you run it. | The card shows "Descaling" and the time left. Start is disabled. No cook notifications. "Descale needed" goes away at the end. | |

## Emergency power cut (0.21.0)

Set `power_switch`, `power_sensor` and `power_cut_minutes` first. For a
quick test, set `power_cut_minutes` to 2.

| Test | What to do | Expected result | Passed |
|---|---|---|---|
| Power comes back | Oven idle: turn the plug off, then on. | Note what the oven display shows. | |
| Alarm on a lost oven | Start a short bake. Block the oven's network in the router for 6 minutes. Do not stop the App: the alarm runs inside it. | After 5 minutes: an alarm on every phone with two buttons. | |
| I am here | Tap "I am here" on the alarm. | Every phone shows "… is at the oven". No cut. | |
| Turn off power | Repeat the alarm. Tap "Turn off power". | The plug goes off. Every phone shows who turned it off. | |
| No answer | Repeat the alarm. Do not answer. | After `power_cut_minutes`, the plug goes off and every phone gets a message. | |
| Short drop | The oven loses Wi-Fi for less than 5 minutes during a cook. | No alarm. | |

## Start later (0.23.0, after all upstream PRs are merged)

The card does not show this yet. Use the Anova Oven device in HA.

| Test | What to do | Expected result | Passed |
|---|---|---|---|
| Start in | Choose a recipe. Set "Start in minutes" to 2 and press "Start in". | Every phone gets "Scheduled cook". The oven starts after 2 minutes. | |
| Cancel | Schedule a cook, then press "Cancel scheduled start". | The oven does not start. | |
| Oven busy | Schedule a cook while another cook runs. | At the start time, every phone gets "The scheduled cook did not start". | |

## Tests that passed

| Test | App version |
|---|---|
| Descale flow (no cook, time left, flag clears at the end) | 0.17.x |
| "Visit" link on the App page | 0.19.2 |
| Card header opens the device page | 0.19.2 |
| Lamp follows the cook | 0.19.2 |
| Start and stop a short cook from the card | 0.19.2 |

## Backlog (not built yet)

- Shelly script as a last guard when HA is down (step 6).
