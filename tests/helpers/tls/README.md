# TLS test fixtures

**Test-only, throwaway certificates. None of this protects anything.** They exist so
`tests/integration/database-tls.test.ts` can run the app's real TLS configuration against a
real Postgres in CI, where Postgres itself has no TLS (`tests/helpers/tls-postgres-proxy.ts`
puts a TLS front on it).

| File | What it is |
|---|---|
| `test-ca.crt` | The CA the app is configured to trust in the tests (`DATABASE_SSL_CA_B64`). |
| `other-ca.crt` | An unrelated CA — proves a certificate from a CA you did NOT configure is refused. |
| `server-localhost.{crt,key}` | Server certificate signed by `test-ca.crt`, names `localhost`. |
| `server-wrongname.{crt,key}` | Signed by `test-ca.crt` too, but names only `not-localhost.example` — proves the hostname is checked, not just the chain. |

Valid ~100 years. The CA's **private key was deleted** after signing, so nothing new can be
issued under `test-ca.crt`; regenerating means creating a new CA and replacing all of these.

Regenerate (Git Bash on Windows: run `openssl` from a *relative* scratch directory with
`MSYS_NO_PATHCONV=1`, otherwise `-subj "/CN=…"` is rewritten into a filesystem path):

```sh
export MSYS_NO_PATHCONV=1; mkdir _ca_scratch; D=36500
openssl req -x509 -newkey rsa:2048 -nodes -keyout _ca_scratch/ca.key -out test-ca.crt -days $D -subj "/CN=BJJ Alliance test-only CA"
openssl req -x509 -newkey rsa:2048 -nodes -keyout _ca_scratch/other.key -out other-ca.crt -days $D -subj "/CN=BJJ Alliance unrelated test-only CA"
for pair in "localhost:DNS:localhost" "wrongname:DNS:not-localhost.example"; do
  name=${pair%%:*}; san=${pair#*:}
  openssl req -newkey rsa:2048 -nodes -keyout server-$name.key -out _ca_scratch/$name.csr -subj "/CN=$name"
  printf "subjectAltName=%s\n" "$san" > _ca_scratch/$name.cnf
  openssl x509 -req -in _ca_scratch/$name.csr -CA test-ca.crt -CAkey _ca_scratch/ca.key -CAcreateserial \
    -CAserial _ca_scratch/ca.srl -out server-$name.crt -days $D -extfile _ca_scratch/$name.cnf
done
rm -rf _ca_scratch
```
