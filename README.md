# Implement red packet on solana
The project is based on the original code:
https://github.com/DimensionDev/RedPacket/.
And make the red packet support on Solana network.

## Get Started
```
anchor build

anchor test
```
** right now, withdraw test pass will fail, because time check. Maybe need to use bankrun to rewrite withdraw test.

## Audit report

 [audit report](audit_report/audit_report.pdf)

## Contribute
Any contribution is welcomed to make it better.

If you have any questions, please create an [issue](https://github.com/DimensionDev/solana-redpacket/issues).

## Security report

If you have any security issue, please send to <security@mask.io>.

## future feature list 
- [ ] claimer can specify a recipient account instead of the claimer's account itself
- [ ] NFT red packet