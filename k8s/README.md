# Running PlainChain on Kubernetes

`k8s/base` is a three-node mesh: a `StatefulSet` (stable pod names, one
persistent volume per node), a headless `Service` for peer DNS
(`l1-node-N.l1-node`), and a cluster-internal `Service` for RPC. It is the
Kubernetes analogue of `docker-compose.yml` and uses the same `L1_*`
environment variables (`src/node/settings.ts`).

## Any cluster

```bash
kubectl apply -k k8s/base
kubectl -n l1 rollout status statefulset/l1-node
```

Before a real deployment:

- **Image.** The base references `ghcr.io/behrouzbk/plainchain:main`,
  published by `.github/workflows/release.yml` on every push to `main`
  (`vX.Y.Z` tags publish `X.Y.Z`, `X.Y` and `latest`). Pin a version with
  `cd k8s/base && kustomize edit set image ghcr.io/behrouzbk/plainchain=ghcr.io/behrouzbk/plainchain:0.1.2`.
  While the repository is private the package is too; give the cluster a
  pull secret named `ghcr-pull` (the StatefulSet already references it):
  `kubectl -n l1 create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<github user> --docker-password=<token with read:packages>`.
- **RPC token.** `secret.yaml` ships a placeholder so `apply -k` works out
  of the box. Replace it: `kubectl -n l1 create secret generic l1-node --from-literal=L1_RPC_TOKEN="$(openssl rand -hex 32)" --dry-run=client -o yaml | kubectl apply -f -`
  and restart the pods.
- **RPC exposure.** RPC is a `ClusterIP` service, reachable only inside the
  cluster, which is why `L1_RPC_ALLOW_INSECURE=true` is set. To expose it,
  mount a certificate (`npm run gen-cert`, or cert-manager) and set
  `L1_RPC_TLS_CERT` / `L1_RPC_TLS_KEY` instead; the node refuses cleartext
  on `0.0.0.0` without them.
- **Chain.** The image carries `config/default.json` (the devnet). For your
  own chain mount a config file and set `L1_CONFIG=/config/chain.json`;
  for proof of authority also mount each authority's key and set
  `L1_SIGNER_KEY` on that pod (`npm run gen-authority`).
- **Storage.** `volumeClaimTemplates` asks for 1 Gi per node from the
  default storage class; size it for the chain you expect (blocks, undo
  records and the tx index are never pruned; `L1_ADDRINDEX_DEPTH` bounds
  the wallet-history index).

Talking to one node (for `mine`, or to check convergence):

```bash
kubectl -n l1 port-forward pod/l1-node-0 9001:9001 &
kubectl -n l1 port-forward pod/l1-node-1 9002:9001 &
kubectl -n l1 port-forward pod/l1-node-2 9003:9001 &
L1_RPC_TOKEN=<token> npm run testnet:check      # health, mine on node 0, others converge
```

## Local cluster (kind)

```bash
docker build -t plainchain:local .
kind create cluster --name l1
kind load docker-image plainchain:local --name l1
kubectl apply -k k8s/kind                        # base + the local image
kubectl -n l1 rollout status statefulset/l1-node
```

Then port-forward and run `npm run testnet:check` as above with the
placeholder token (`change-me-testnet-rpc-token`). `kind delete cluster
--name l1` removes everything.

## Managed Kubernetes (GKE, EKS, AKS)

The base works unchanged on managed clusters. Two things usually differ:
the image is pulled from the cloud's own registry (push the image there
and override it with a small overlay like `k8s/kind`), and autopilot-style
clusters enforce minimum pod sizes (on GKE Autopilot, request at least
250m CPU and 512Mi memory and set limits equal to requests). Delete the
persistent disks explicitly when tearing a cluster down; most providers
keep them after the cluster is gone.

## How the mesh forms

Every pod dials `l1-node-0` and `l1-node-1` (`L1_PEERS`); a dial to itself
is collapsed by the P2P layer, a dial to a pod that is still starting is
retried by the address book, and peer discovery (`GET_PEERS`) fills in the
rest, so all three end up with two peers. `podManagementPolicy:
OrderedReady` starts pods one at a time once the previous is ready, like
`depends_on: service_healthy` in the compose file. Each node advertises
`ws://<pod>.l1-node:8001`, its stable DNS name, so discovery hands out
addresses that survive pod restarts. A restarted pod keeps its chain on
its persistent volume and reconnects from its persisted address book.
