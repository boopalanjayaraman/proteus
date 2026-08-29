

## eBay/digital-signature-verification-ebay-api (Enterprise B2B Reference)

Repository: 
eBay/digital-signature-verification-ebay-api
Stack: Java, Spring Boot, Bouncy Castle (bcprov-jdk15on), Nimbus JOSE.
Business Flow: Financial HTTP request envelope signing and verification (RFC 9421 compliant).
Why it fits: It provides an enterprise-grade Spring Boot baseline with clear unit/integration test suites. It validates incoming signed payloads at an API gateway boundary, simulating external counterparty constraints.

## ThalesGroup/java-buildpack-luna-sample (Dual RSA Usage Example)

Repository: 
ThalesGroup/java-buildpack-luna-sample
Stack: Java, Spring Boot (@SpringBootApplication), JCA providers.
Crypto in Use: Contains distinct beans for both Cipher.getInstance("RSA/...") (encryption/key transport) and Signature.getInstance("RSA") (signing).
Why it fits: It directly demonstrates the dual-primitive requirement, allowing your agent to prove it can classify cryptographic intent (migrating the Cipher to ML-KEM while applying distinct policy rules to the Signature).