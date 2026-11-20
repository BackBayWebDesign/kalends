#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: BackBayWebDesign
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/BackBayWebDesign/kalends

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

NODE_VERSION="24" setup_nodejs
fetch_and_deploy_gh_release "kalends" "BackBayWebDesign/kalends" "tarball"

msg_info "Setting up Kalends"
cd /opt/kalends
$STD npm ci --omit=dev
mkdir -p /opt/kalends/data/photos
cat <<EOF >/opt/kalends.env
PORT=3000
HOST=0.0.0.0
DATA_DIR=/opt/kalends/data
EOF
msg_ok "Set up Kalends"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/kalends.service
[Unit]
Description=Kalends wall calendar
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/kalends
EnvironmentFile=/opt/kalends.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/kalends/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now kalends
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
