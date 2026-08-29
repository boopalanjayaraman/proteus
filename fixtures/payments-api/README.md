# payments-api

Northwind Pay settlement service. A B2B settlement exchange with an acquiring bank.

## Run

    mvn spring-boot:run        # http://localhost:8080

The console shows the mechanisms currently in use and lets you settle an advice.

## Test

    mvn test        # unit
    mvn verify      # unit + integration

## What it does

A settlement establishes a symmetric session key with the acquirer, transports that key
to them under their public key, signs the advice, and returns an envelope. The two
cryptographic steps are independent — the session key protects the exchange, the
signature attests to the advice.

    POST /settlements   →  201 accepted, 400 malformed
    GET  /              →  operator console
    GET  /healthz       →  liveness
