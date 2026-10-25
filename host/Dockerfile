ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE}
COPY --chmod=0555 dashboard_control.py /opt/hermes-paseo-dashboard-control/dashboard_control.py
COPY --chmod=0555 profile_lifecycle.py /opt/hermes-paseo-dashboard-control/profile_lifecycle.py
COPY --chmod=0555 resource_limits.py /opt/hermes-paseo-dashboard-control/resource_limits.py
COPY --chmod=0555 hermes /opt/hermes/.venv/bin/hermes
