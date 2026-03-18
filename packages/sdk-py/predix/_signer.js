/**
 * Unified Stacks signer for the Predix Python SDK.
 * Reads JSON commands from stdin, writes JSON results to stdout.
 * Private key is passed via stdin (never in command args).
 *
 * Actions: derive, sign, signMessage
 */
const readline = require('readline')
const crypto = require('crypto')
const {
  createStacksPrivateKey,
  pubKeyfromPrivKey,
  publicKeyToHex,
  deserializeTransaction,
  TransactionSigner,
  signMessageHashRsv,
} = require('@stacks/transactions')
const { getStxAddress } = require('@stacks/wallet-sdk')

function hashMessage(message) {
  const prefix = '\x17Stacks Signed Message:\n'
  const msgBytes = Buffer.from(message, 'utf8')
  const lenBytes = msgBytes.length < 0xfd
    ? Buffer.from([msgBytes.length])
    : Buffer.from([0xfd, msgBytes.length & 0xff, (msgBytes.length >> 8) & 0xff])
  const full = Buffer.concat([Buffer.from(prefix, 'utf8'), lenBytes, msgBytes])
  return crypto.createHash('sha256').update(full).digest('hex')
}

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  try {
    const cmd = JSON.parse(line)

    if (cmd.action === 'derive') {
      const address = getStxAddress({
        account: {
          stxPrivateKey: cmd.privateKey,
          dataPrivateKey: '',
          appsKey: '',
          salt: '',
          index: 0,
        },
        network: cmd.network || 'testnet',
      })
      const pubKey = publicKeyToHex(
        pubKeyfromPrivKey(createStacksPrivateKey(cmd.privateKey))
      )
      console.log(JSON.stringify({ address, publicKey: pubKey }))
    } else if (cmd.action === 'sign') {
      const tx = deserializeTransaction(cmd.txHex)
      const signer = new TransactionSigner(tx)
      signer.signOrigin(createStacksPrivateKey(cmd.privateKey))
      console.log(JSON.stringify({ signedHex: tx.serialize() }))
    } else if (cmd.action === 'signMessage') {
      const messageHash = hashMessage(cmd.message)
      const signature = signMessageHashRsv({ messageHash, privateKey: cmd.privateKey })
      console.log(JSON.stringify({ signature }))
    } else {
      console.log(JSON.stringify({ error: `Unknown action: ${cmd.action}` }))
    }
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }))
  }
  rl.close()
})
