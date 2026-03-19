import { Command } from 'commander'

const program = new Command()

program
  .name('burn0')
  .description('Lightweight cost observability for every API call in your stack')
  .version('0.1.0')

program
  .command('init')
  .description('Interactive setup wizard')
  .action(async () => {
    const { runInit } = await import('./init')
    await runInit()
  })

program
  .command('status')
  .description('Show tracked services, mode, and connection status')
  .action(async () => {
    const { runStatus } = await import('./status')
    await runStatus()
  })

program
  .command('connect')
  .description('Add your burn0 API key')
  .action(async () => {
    const { runConnect } = await import('./connect')
    await runConnect()
  })

program
  .command('report')
  .description('Show cost summary')
  .action(async () => {
    const { runReport } = await import('./report')
    await runReport()
  })

program
  .command('dev')
  .description('Run your app with burn0 cost tracking')
  .argument('[command...]', 'Command to run')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (command: string[]) => {
    const { runDev } = await import('./dev')
    await runDev(command)
  })

program.parse()
