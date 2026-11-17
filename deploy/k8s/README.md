# SagaFlow Kubernetes Deployment (Horizontal Auto-Scaling)

This folder deploys SagaFlow in **split-role production architecture** ($0 open-source stack: Kubernetes + PostgreSQL 17 RLS + NATS JetStream):

- `sagaflow-api` (`ROLE=api`, 2 replicas): Serves the React Studio UI, REST APIs, SSE streams (with `proxy-buffering: off`), and inbound webhooks.
- `sagaflow-worker` (`ROLE=worker`, HPA **2 → 10 pods**): Consumes NATS JetStream jobs, executes DAG steps + QuickJS-WASM sandboxes + Saga compensations, and runs the minute-idempotent Durable Cron Scheduler.
- `sagaflow-postgres`: PostgreSQL 17 with native Row-Level Security (`app.current_tenant`).
- `sagaflow-nats`: NATS JetStream durable work-queue.

## Deploy

```bash
# 1. Build image locally (or push to your registry)
docker build -t sagaflow:latest .

# 2. Edit secrets in deploy/k8s/00-namespace-config.yaml, then apply:
kubectl apply -f deploy/k8s/

# 3. Watch pods & HPA
kubectl -n sagaflow get pods,hpa
```
