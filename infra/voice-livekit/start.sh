#!/bin/sh
set -eu
: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET required}"
: "${LIVEKIT_NODE_IP:?LIVEKIT_NODE_IP required}"
# LiveKit handles RTP on one UDP mux port. Advertise Fly's dedicated address,
# never the egress/STUN address, which the Fly ingress does not route back.
umask 077
voice_config=$(mktemp /tmp/beeline-livekit.XXXXXX)
cat > "$voice_config" <<EOF
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  node_ip: ${LIVEKIT_NODE_IP}
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
room:
  empty_timeout: 60
  departure_timeout: 20
logging:
  level: warn
EOF
exec /livekit-server --bind 0.0.0.0 --config "$voice_config"
