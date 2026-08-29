For the ideal main demo repo, I’d use these criteria:

Java + Spring Boot so the migration target is enterprise-realistic.
RSA-2048 used for key transport / key establishment, not only signatures.
Simple, self-contained app with minimal DB/auth/infrastructure distractions.
Known working baseline with existing tests.
At least one realistic external boundary that can be mocked.
No HSM dependency for the main demo, so migration can complete autonomously.
Clear business flow such as B2B payment/transaction exchange.
Crypto usage is easy to observe but not trivial search-and-replace.
A second RSA usage for signatures is ideal, so the agent proves it can distinguish “migrate” vs “do not migrate”.
Can run locally and in Cloud Run, with reproducible build/test steps.
Small enough that the agent can migrate it reliably during a live demo.