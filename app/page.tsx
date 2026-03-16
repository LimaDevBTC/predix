import { MarketCardV4Wrapper } from '@/components/MarketCardV4Wrapper'
import { Footer } from '@/components/Footer'

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950">
      <div className="w-full max-w-2xl lg:max-w-6xl xl:max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-10">
        <MarketCardV4Wrapper />

        <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:p-5 text-sm text-zinc-400">
          <h3 className="font-semibold text-zinc-300 mb-3">How it works</h3>
          <ul className="space-y-1.5">
            <li>• Each round lasts <strong className="text-zinc-300">1 minute</strong>. Predictions close <strong className="text-zinc-300">5 seconds</strong> before the round ends.</li>
            <li>• Choose <strong className="text-up">UP</strong> if you think BTC will rise, or <strong className="text-down">DOWN</strong> if you think it will fall.</li>
            <li>• All predictions go into a shared pool. When the round ends, the <strong className="text-zinc-300">losing side pays the winning side</strong>.</li>
            <li>• Your payout depends on your share of the winning pool: the fewer people on your side, the bigger your reward.</li>
          </ul>

          <h4 className="font-semibold text-yellow-400 mt-4 mb-2 flex items-center gap-1.5">
            <img src="/moneybag.png" alt="" className="w-4 h-4" />
            Jackpot
          </h4>
          <ul className="space-y-1.5">
            <li>• <strong className="text-zinc-300">1% of each round&apos;s volume</strong> goes into the Jackpot pool.</li>
            <li>• Predict within the <strong className="text-yellow-400">first 20 seconds</strong> of a round to qualify.</li>
            <li>• At round end, the Jackpot is distributed <strong className="text-zinc-300">proportionally</strong> among all early predictors on the winning side.</li>
            <li>• The earlier and bigger you predict, the larger your share of the Jackpot.</li>
          </ul>

          <h4 className="font-semibold text-zinc-300 mt-4 mb-2">Zero gas fees, fully automated</h4>
          <ul className="space-y-1.5">
            <li>• <strong className="text-zinc-300">All transactions are sponsored</strong> — you never pay gas fees. We cover every on-chain transaction.</li>
            <li>• <strong className="text-zinc-300">Auto-resolve &amp; auto-claim</strong> — rounds are settled automatically and winnings are claimed for you. No manual steps needed.</li>
            <li>• Everything runs on-chain on <strong className="text-zinc-300">Stacks</strong>, secured by Bitcoin.</li>
          </ul>
        </section>

        <Footer />
      </div>
    </main>
  )
}
