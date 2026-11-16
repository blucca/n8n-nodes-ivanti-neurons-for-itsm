# Saved Search paging in real n8n

A successful execution can contain only Ivanti's first 25 matches. This lab
runs the complete compiled community node in **n8n 2.46.6**, with the normal
package loader, imported credentials and real HTTP transport. Its local
fixture reproduces the default-25 paging described in [issue #72](https://github.com/syn-con/n8n-nodes-ivanti-neurons-for-itsm/issues/72).

## Recorded results

Both workflows finished successfully. Each row below was read independently
from n8n's raw execution data; complete records, ordered IDs and paired items
were checked. The HTTP server separately recorded all 11 physical requests.

| Source / node version | Fixture matches | Requested output | Actual output |
|---|---:|---|---:|
| Upstream stock / 1.3 | 37 | Saved search | **25** |
| Patched / 1.3 | 37 | Legacy behavior | **25**, unchanged |
| Patched / 1.4 | 37 | Default Return All | **37** |
| Patched / 1.4 | 137 | Return All | **137**, pages 100 + 37 |
| Patched / 1.4 | 137 | Limit 120 | **120**, pages 100 + 20 |
| Patched / 1.4 | 37 | Limit 10 | **10** |
| Patched / 1.4 | 0 | Return All | **0** |
| Patched / 1.4 | 100 | Return All | **100**, then HTTP 204 |

The 137-row control uses overridden Authorization and X-Fixture headers;
both requests retain them and the same ActionId. A saved search supplies
its own ordering, so this patch adds no `$orderby` parameter.

## Install the released fix

[PR #74](https://github.com/syn-con/n8n-nodes-ivanti-neurons-for-itsm/pull/74)
was merged on November 15, 2026. The fix is now included in the published
[`@synergyconsulting/n8n-nodes-ivanti-neurons-for-itsm` **1.10.0**](https://www.npmjs.com/package/@synergyconsulting/n8n-nodes-ivanti-neurons-for-itsm/v/1.10.0).
Update the community package, then create a **Search → Saved** node on
version **1.4**. Existing nodes on versions 1–1.3 keep their single request;
updating the package alone leaves that legacy behavior in place.

The recorded native results below use the pinned source patch. The published
1.10.0 package was separately checked for node 1.4 and its Return All / Limit
paging code; the native lab was run against the commits shown below.

See [observed-results.json](observed-results.json). Its
`complete_search_contract` field asks whether **all fixture matches** were
returned: it is false for the legacy cutoff and for deliberately limited
requests. Each limited result separately matches its requested limit exactly.

## Run the complete check

Measured environment: Linux, Python 3.12.3, Node 24.21.0, n8n 2.46.6, and
community package 1.9.1 as the stock control, compared with the pinned
source patch adding node version 1.4. Use these exact commits to reproduce
the recorded results. For your own tenant, install package 1.10.0 as above.

Prepare stock and patched source trees, using Node 24:

```sh
git clone https://github.com/syn-con/n8n-nodes-ivanti-neurons-for-itsm.git ivanti-stock
git -C ivanti-stock checkout 3de7b0e06c595dabfb6c165ca14644035dc36d8e
(cd ivanti-stock && npm ci && npm run build)

git clone https://github.com/blucca/n8n-nodes-ivanti-neurons-for-itsm.git ivanti-fixed
git -C ivanti-fixed checkout f92b804ec38aa3d9ea4929e1efb8b47ae2cc1828
(cd ivanti-fixed && npm ci && npm run build)
```

Use an existing n8n 2.46.6 runtime directory, where
`node_modules/n8n/bin/n8n` exists. To prepare a separate one:

```sh
mkdir n8n-runtime
(cd n8n-runtime && npm init -y && npm install n8n@2.46.6)
```

Run from the directory containing both source trees, the runtime, and this
lab's extracted files. `my-results` must be a new directory:

```sh
python3 probe.py --runtime ./n8n-runtime --stock ./ivanti-stock \
  --fixed ./ivanti-fixed --out ./my-results
```

The script starts a loopback HTTP fixture, mounts each source package in a
fresh n8n user folder with an explicitly local SQLite database, imports a
synthetic credential, imports the workflow,
and executes it. It then checks the real outputs and HTTP requests. The
fixture server stops on completion; existing n8n data and workflows stay in
their own user folder. Output includes the two workflow exports, full raw
executions, HTTP records and stage logs. No live Ivanti tenant is contacted.

The JSON exports here are the exact recorded stock/fixed workflow inputs.
`probe.py` supplies their fixture credential and temporary server address.

## Check your own tenant

With package **1.10.0** installed, create a new **Search → Saved** node
on version **1.4**, copying the business object, saved search name, ActionId
and any options from the old node. Run the same search with Return All,
then an explicit Limit. Compare the complete IDs/count with your tenant's
known result. Existing nodes on versions 1–1.3 retain their single request.

Original cloud-2026.2 measurements and proposed compatibility plan: tyrunasj /
Tyrunas Jokubauskas, [issue #72](https://github.com/syn-con/n8n-nodes-ivanti-neurons-for-itsm/issues/72).
The synthetic fixture, native checks and patch are by Blucca. Source uses
the repository's MIT license.
