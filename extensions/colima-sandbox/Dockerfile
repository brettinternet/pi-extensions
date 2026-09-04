# The Node tag is intentionally exact; Debian packages are installed from the
# pinned Bookworm base's repository and no package-manager state is retained.
FROM node:22.19.0-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
      bash \
      ca-certificates \
      git \
      ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace /run /tmp \
    && chown node:node /workspace /run /tmp /home/node \
    && chmod 1777 /tmp

COPY broker.mjs /usr/local/bin/pi-colima-sandbox-broker
RUN chmod 0555 /usr/local/bin/pi-colima-sandbox-broker

ENV HOME=/home/node \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TMPDIR=/tmp \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    NPM_CONFIG_USERCONFIG=/dev/null

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
