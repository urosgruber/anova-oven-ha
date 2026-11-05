#!/usr/bin/with-contenv bashio
# Start the server in local mode. The Supervisor provides the MQTT login,
# so no MQTT user is needed.
set -e

export ANOVA_MODE=local
export ANOVA_DATA_DIR=/data
export ANOVA_DEVICE_BIND=0.0.0.0:4443
export ANOVA_BIND=0.0.0.0:8080
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

exec /usr/bin/anova-oven-server
