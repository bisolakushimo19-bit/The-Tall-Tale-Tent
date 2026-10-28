# The Tall Tale Tent

![The Tall Tale Tent: the reveal, with the WHOPPER stamp on the lie and the players it fooled](cover_image.jpg)

**Play now:** _(add the Render link after deploying)_. Enter a name and tap **Practice with bots** for a full game against three sideshow performers.

Two truths and a lie, set in a county-fair sideshow, for 4–15 players. The Node server owns each room, every timer, the shuffled A/B/C order and the lie. No client learns where the lie sits until the reveal. Players join with a four-letter tent code. No account is needed.

## Run locally

Requires Node.js 18 or newer. The server uses Node's built-in HTTP module and a small hand-written WebSocket layer, so there are no packages to install.

```sh
npm start        # http://localhost:3004
npm test         # 14 end-to-end tests over real WebSockets (Node 22+)
```

Other devices on the same network can join at the host computer's local IP address in place of `localhost`. To deploy, use any Node host that supports WebSockets (Render: Build `npm install`, Start `npm start`, Health Check Path `/healthz`).

## Game rules

- **Writing (90 s):** each player writes three tales of up to 100 characters each and marks one as the lie. Prompt chips fill in a starter. Players can edit and hand in again until time runs out. Writing ends early once everyone has handed in.
- **Spotlight:** players take turns in random order. Each turn is READ (10 s), BET (25 s), then REVEAL (10 s). The author's tales appear as tickets A, B and C, shuffled on the server. The author sees "Keep a straight face" and cannot bet.
- **Bets:** tap a ticket, optionally turn on **Go Double**, and **Lock it in**. A bet can be changed until time runs out, but changing it means locking in again. Bets that aren't locked in count as no bet and spend no chip. Each player has one chip per game, or two in games of 10 or more. Once everyone has locked in, the bet phase closes 3 seconds later.
- **Work the spotlight (author twist):** once per game, during their own betting phase, the author can swing the spotlight onto one ticket. Everyone sees where it lands; only the author knows whether it's an honest hint, a bluff, or a double bluff. A spotlight swing is refunded if that turn is cancelled.
- **Last Call (guesser twist):** after the 25-second bet phase, a 6-second Last Call flips the tote board, showing how many locked bets sit on A, B and C (counts only, never names). Bets can still be switched or locked in.
- **Scoring:** right +100 (+200 with Go Double), wrong 0 (−50 with Go Double). The author gets +50 for each wrong guess. **Long shot +50:** you were already on the whopper before Last Call and it held under half of the tote. Switching onto it at Last Call doesn't count.
- **Final:** a leaderboard and three awards: Best Poker Face (most people fooled), Sharp Eye (most correct guesses) and Boldest Bet (most Go Doubles won), plus two for the twists: Long Shot (most long-shot bonuses) and Smoke and Mirrors (most people led onto a true ticket by a bluffed spotlight). The final also shows the Whopper of the Night and a shareable ticket stub. **Play again** keeps the room and clears every tale, score and chip.

## The Barker (host) tools

- **+15 s:** up to 3 times per phase, during writing, reading or betting.
- **Skip this player:** cancels the current spotlight with no points. During writing, **Close the booth now** ends writing early.
- **Remove these tales:** tap twice. This hides the tales and skips that spotlight. During a reveal, any points already awarded are rolled back.
- If the Barker leaves, the role passes to the human who has been connected longest. A refresh keeps the role for 15 seconds.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Missed the writing deadline | Skipped. Shown as "The Mystery Guest sat this one out" |
| Only one tale handed in | The game ends early with a message |
| Author leaves before their turn | Skipped without penalty |
| Author leaves during their spotlight | Cancelled after 5 s with no points (a quick refresh doesn't cancel it) |
| Guesser disconnects | Counts as no bet |
| Late joiner | Watches every spotlight and is dealt in at the next game |
| Classroom mode | First names only, stricter blocklist, timers 25% longer |

## Moderation and privacy

- `blocklist.json` is the editable word filter. Words in `party` apply to every room, and words in `classroom` are added on top in Classroom mode. The base profanity and slur list is stored ROT13-encoded in the same file. The filter also catches leetspeak (`sh1t`), spaced-out letters, phone numbers, email addresses, links and @handles. Rejected text gets the message: "The Barker cannot read that out loud."
- Tales live only in server memory. They are cleared on Play again and deleted when the tent closes (30 minutes after the last human leaves). Only `index.html`, `client.js`, `fx.js` and `style.css` are served; `botsets.json` and `blocklist.json` never are.
- All player text is rendered as text, never as HTML.

## Practice mode

**Practice with bots** seats you with Madame Zola, Barnaby Pike and Tilly Tumble. Each bot tells one of six all-ages tale sets from `botsets.json`. Bot guessers pick at random, leaning a little toward the real lie (45%), and spend Go Double chips now and then. Bot authors swing the spotlight about half the time, onto a true ticket more often than onto the lie. The Barker can also add bots to any lobby.

## Game feel

The UI borrows proven patterns from party and quiz games, rebuilt in the sideshow style:

- **Landing page:** a scrolling ticker, a marquee sign with chasing bulbs, a "Tonight in the tent" parade of the performers (your seat shows your name as you type it), a Prize Board listing every way to score, and a pulsing Quick Play button.
- **Carnival avatars:** each seat gets its own emoji token (top hat, carousel, lion and so on), used everywhere: the lobby, the lock-in rail, the bets on each ticket, the standings and the podium.
- **The HUD:** a ticket-booth bar fixed to the bottom of the screen shows your score, your rank, your Go Double chips, whether your spotlight swing is still available, and your 🔥 streak. It keeps the old numbers until the stamp lands, so it can't spoil a reveal.
- **Title card:** each turn opens with the player's name and avatar ("steps into the spotlight").
- **Lock-in rail:** every guesser's avatar bobs while they think and gets an IN stamp when they lock in. Choices stay hidden.
- **Staged reveal:** the bets drop onto their tickets, the truths flip one at a time with a TRUE stamp, the lie shivers through a drum roll, then WHOPPER! lands. Points float over each player's avatar.
- **Standings after every tale:** drawn in the old order, then reshuffled into the new one, with ▲/▼ moves and points gained.
- **Streaks:** consecutive whoppers spotted. They give XP and status but no points, so leaders don't run away with the game.
- **Final podium:** the bars rise from third place to first, the winner gets a crown and confetti, and the ribbons are revealed one at a time.
- **Crowd reactions:** six emoji (😂 😱 🤥 👏 🔥 🤔) float up on everyone's screen. The server relays them and allows one per player every 0.6 seconds. Bots react too.


`fx.js` adds midway ranks from Rube to Legend of the Midway, XP, and eight ribbons (including Long Shot and Smoke and Mirrors), all saved on the device. It also provides the drum roll and stamp on each reveal, ticket-confetti bursts and count-ups. A "Your move" bar tells each player what to do right now. A three-card how-to plays on the first visit. The timer is announced to screen readers every 10 seconds. Selection is shown by a border and a check mark, not by colour alone. Tap targets are at least 44 px, inputs use 16 px text or larger, and reduced-motion settings are respected.

Submission details (title, description, cover, link) are in [SUBMISSION.md](SUBMISSION.md).
