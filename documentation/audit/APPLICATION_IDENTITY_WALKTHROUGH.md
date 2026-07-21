# Application identity walkthrough (Prompt 7G)

The executor prepares the local services. The researcher only opens
`http://localhost:3000/login` and chooses synthetic inputs; no SQL, migrations,
cookies, hashes, commands or infrastructure inspection are required.

| Teste ou grupo | O que está sendo testado em linguagem comum | Resultado |
|---|---|---|
| Teste A — verified student | A reserva usa a conta que iniciou a sessão, não uma identidade escolhida no formulário. | Pendente do walkthrough |
| Teste B — revoked link | Uma conta ativa pode ter ligação institucional revogada, sem confundir isso com conta desativada. | Pendente do walkthrough |
| Teste C — disabled account | Uma conta desativada não inicia sessão antes de qualquer evidência ou reserva. | Pendente do walkthrough |
| Logout | Sair encerra somente a sessão local criada para aquele navegador. | Pendente do walkthrough |

The local synthetic session is for research and development only. It is not
production authentication.

The disabled account path is covered by the executor and automated tests with
HTTP 403. The visually disabled option was not a researcher manual action in
this stage and will be reconsidered with the final UX.
