# Docker shortcuts. Local targets use compose.yaml + compose.override.yaml (auto-loaded);
# prod-* targets use compose.yaml only, with external PostgreSQL/Valkey (see README.md).
#
#   make help                     list targets
#   make up / down / logs s=api   local stack
#   make prod-up ENV_FILE=.env.stage

COMPOSE      ?= docker compose
ENV_FILE     ?= .env.production
PROD_COMPOSE  = $(COMPOSE) --env-file $(ENV_FILE) -f compose.yaml
INFRA         = postgres valkey mailpit
APP           = api dispatcher worker-email
# Optional service filter, e.g. `make logs s=worker-email`.
s            ?=
# config-apply file under ./config (mounted at /config).
CONFIG       ?= local.example.json

.DEFAULT_GOAL := help
.PHONY: help build up up-infra down stop restart ps logs migrate config-apply \
	psql valkey-cli shell clean smoke prod-config prod-migrate prod-up prod-down prod-ps prod-logs

help: ## Show this help
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## --- Local -------------------------------------------------------------------

build: ## Build the service image
	$(COMPOSE) build

up: ## Start the full local stack (build, wait for healthchecks)
	$(COMPOSE) up -d --build --wait

up-infra: ## Start only PostgreSQL, Valkey and Mailpit (app on the host)
	$(COMPOSE) up -d --wait $(INFRA)

down: ## Stop and remove containers (volumes kept)
	$(COMPOSE) --profile tools down --remove-orphans

stop: ## Stop containers gracefully (SIGTERM)
	$(COMPOSE) stop $(s)

restart: ## Restart app services (or s=<service>)
	$(COMPOSE) restart $(or $(s),$(APP))

ps: ## Show service status
	$(COMPOSE) ps -a

logs: ## Follow logs (all, or s=<service>)
	$(COMPOSE) logs -f --tail 100 $(s)

migrate: ## Run database migrations
	$(COMPOSE) run --rm migrate

config-apply: ## Apply config/<CONFIG> (new API keys printed once)
	$(COMPOSE) run --rm config-apply --file /config/$(CONFIG)

psql: ## Open psql on the local database
	$(COMPOSE) exec postgres psql -U notifications -d notifications

valkey-cli: ## Open valkey-cli on the local Valkey
	$(COMPOSE) exec valkey valkey-cli

shell: ## Open a shell in a service (s=api by default)
	$(COMPOSE) exec $(or $(s),api) sh

clean: ## Remove containers AND volumes (deletes local data)
	$(COMPOSE) --profile tools down -v --remove-orphans

smoke: ## Run the isolated end-to-end smoke test
	scripts/smoke-local.sh

## --- Stage / production (ENV_FILE=.env.production) ----------------------------

prod-config: ## Render the resolved production compose config
	$(PROD_COMPOSE) config

prod-migrate: ## Run migrations against the external database
	$(PROD_COMPOSE) run --rm migrate

prod-up: ## Start app services (no infrastructure)
	$(PROD_COMPOSE) up -d

prod-down: ## Stop and remove app services
	$(PROD_COMPOSE) down

prod-ps: ## Show production service status
	$(PROD_COMPOSE) ps

prod-logs: ## Follow production logs (all, or s=<service>)
	$(PROD_COMPOSE) logs -f --tail 100 $(s)
