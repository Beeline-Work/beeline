FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus-user-session ca-certificates curl tar npm git && useradd -m -s /bin/bash proof && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/proof
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
