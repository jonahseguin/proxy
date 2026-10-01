FROM eceasy/cli-proxy-api:v7.3.15@sha256:44c3e6bab6f0aaf3cf80cd6fea58a736454bb0df8e47021d969905bf5d715985
COPY container-start.sh /container-start.sh
# CPA needs a writable home for its auth directory and /tmp for the object-store mirror; nothing else.
RUN useradd --system --create-home --home-dir /home/cpa --shell /usr/sbin/nologin cpa
USER cpa
ENV HOME=/home/cpa
ENTRYPOINT ["/bin/sh", "/container-start.sh"]
