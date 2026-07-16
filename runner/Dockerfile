# Gantry runner image: gemini-cli + the CLIs agents shell out to.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 git curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# The agent loop
RUN npm install -g @google/gemini-cli

# CLIs the agents use through bash (extend as needed)
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY gantry_runner.py /app/gantry_runner.py

ENTRYPOINT ["python3", "/app/gantry_runner.py"]
CMD ["--poll", "10"]
