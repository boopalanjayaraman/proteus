# pay-api leaf certificate

Issued by the Northwind internal CA.

    Subject:             CN=pay-api.northwind-pay.internal
    Signature Algorithm: sha256WithRSAEncryption
    Public Key:          RSA (2048 bit)
    Not After:           2027-03-14

The certificate authenticates this service to the acquirer's gateway. It is
issued by the internal PKI and its algorithm is fixed by the CA profile, not by
this repository.

The PEM is issued per environment and is not committed here.
