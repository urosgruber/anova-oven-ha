#!/usr/bin/with-contenv bashio
# Start the server in local mode. The Supervisor provides the MQTT login,
# so no MQTT user is needed.
set -e

export ANOVA_MODE=local
export ANOVA_DATA_DIR=/data
export ANOVA_DEVICE_BIND=0.0.0.0:4443
export ANOVA_BIND=0.0.0.0:8080
# Stop a dry cook that nothing ends after this many hours; 0 is off.
export ANOVA_SAFETY_LIMIT_HOURS="$(bashio::config 'safety_limit_hours' '4')"
if [ -n "${TZ:-}" ]; then
  export ANOVA_TIMEZONE="${TZ}"
fi

if bashio::config.true 'mqtt' && bashio::services.available mqtt; then
  export ANOVA_MQTT_URL="mqtt://$(bashio::services mqtt host):$(bashio::services mqtt port)"
  export ANOVA_MQTT_USERNAME="$(bashio::services mqtt username)"
  export ANOVA_MQTT_PASSWORD="$(bashio::services mqtt password)"
  bashio::log.info "MQTT on: ${ANOVA_MQTT_URL}"
else
  bashio::log.info "MQTT off"
fi

# Install the dashboard card and register it as a resource. A failure here
# must not stop the server.
python3 /register_card.py || bashio::log.warning "Could not install the dashboard card"

# Send the oven's events to phones. It runs beside the server; if it ends,
# it starts again after 15 s.
if bashio::config.true 'notify'; then
  ( while true; do python3 /notify.py; sleep 15; done ) &
fi

exec /usr/bin/anova-oven-server
