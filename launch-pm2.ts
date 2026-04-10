import * as path from 'path';
import pm2, { StartOptions } from 'pm2';
import { APP_INFOS, APP_PORTS, COMMON_ENV } from '../apps.config';
import { ENABLED_APPS, FEDERATION_APP_NAME } from '../constants';
import { AppInfo } from '../types';
import { awaitAppReady } from '../utils';

const yarnCmd = path.join(process.cwd(), '.yarn/releases/yarn-1.22.19.cjs');

const pm2StartAsync = (pm2AppConfig: StartOptions) => new Promise((resolve, reject) => {
    console.log(`Starting ${pm2AppConfig.name} ...`);

    pm2.start(pm2AppConfig, (err, apps) => {
        if (err) {
            console.error(err);
            reject(err);

            return;
        }
        resolve(apps);
    });
});

function appInfoToPm2Config({ name, env, command, runFromAppFolder }: AppInfo): StartOptions {
    const cwd = runFromAppFolder ? path.join(process.cwd(), 'apps', name) : process.cwd();
    const isNestApp = !runFromAppFolder || command === 'yarn start';
    const args = (command ?? `yarn start ${name}`).replace('yarn ', `${yarnCmd} `).split(' ');
    const baseConfig = {
        name,
        cwd,
        script: args.shift(),
        args,
        env: {
            ...Object.entries(COMMON_ENV)
                .map(([key, value]) => [key, String(value)])
                .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
            ...Object.entries(env)
                .map(([key, value]) => [key, String(value)])
                .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
            PORT: String(APP_PORTS[name]),
        },
    };

    if (isNestApp) return baseConfig;

    return {
        ...baseConfig,
        watch: [`${cwd}/src`],
        ignore_watch: ['**/node_modules', '/dist', '**/@generated', '**/generated', '**/schema.gql'],
    };
}

const handlePm2Connection = (filter?: { include?: string[], exclude?: string[] }) => async (err: unknown) => {
    if (err) {
        console.log('Error connecting to pm2');
        console.error(err);
        process.exit(2);
    }
    console.log('Connected to pm2');

    const appsToStart = APP_INFOS.filter((appInfo) => {
        let keep = false;
        keep = !!filter?.include?.length ? filter.include.includes(appInfo.name) : keep;
        keep = !!filter?.exclude?.length ? !filter.exclude.includes(appInfo.name) : keep;
        keep = keep && appInfo.name !== FEDERATION_APP_NAME && ENABLED_APPS.has(appInfo.name);

        return keep;
    });

    const federationService = APP_INFOS.find(app => app.name === FEDERATION_APP_NAME);

    // Start all apps except federation
    console.log('Waiting for apps federation dependencies to start');
    await Promise.all(appsToStart.map(async (app) => {
        await pm2StartAsync(appInfoToPm2Config(app));
        await awaitAppReady(app.name);
    }));

    // Start federation
    if (federationService && ENABLED_APPS.has(FEDERATION_APP_NAME)) {
        await pm2StartAsync(appInfoToPm2Config(federationService));
        try {
            await awaitAppReady(FEDERATION_APP_NAME);

            console.log('All apps started');
        } catch (error) {
            console.error('Federation service has not been started', error);
        }
    }

    pm2.disconnect();
    console.log('Disconnected from pm2');
};

(() => {
    const { include, exclude } = process.argv.reduce((acc, arg) => ({
        include: acc.include.concat(arg.startsWith('--include=') ? arg.replace('--include=', '').split(',') : []),
        exclude: acc.exclude.concat(arg.startsWith('--exclude=') ? arg.replace('--exclude=', '').split(',') : []),
    }), { include: [], exclude: [] } as { include: string[], exclude: string[] });

    console.log('Starting pm2 apps');
    pm2.connect(handlePm2Connection({ include, exclude }));
})();
