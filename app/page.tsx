import { MarketCardV4Wrapper } from '@/components/MarketCardV4Wrapper'
import { Footer } from '@/components/Footer'

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950">
      <div className="w-full max-w-2xl lg:max-w-6xl xl:max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-10">
        <MarketCardV4Wrapper />

        <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:p-5 text-sm text-zinc-400">
          <h3 className="font-semibold text-zinc-300 mb-2">How it works</h3>
          <ul className="space-y-1.5">
            <li>• Each round lasts <strong className="text-zinc-300">1 minute</strong>.</li>
            <li>• Predictions close <strong className="text-zinc-300">10 seconds before the round ends</strong>.</li>
            <li>• Buy <strong className="text-up">UP</strong> if you think the price will rise, <strong className="text-down">DOWN</strong> if you think it will fall.</li>
            <li>• All bets go into a shared pool. When the round ends, the <strong className="text-zinc-300">losing side&apos;s money pays the winning side</strong>. The more people bet against you, the more you can win.</li>
            <li>• Your payout depends on your share of the winning pool: the fewer people on your side, the more you win.</li>
          </ul>
        </section>

        <Footer />
      </div>
    </main>
  )
}
