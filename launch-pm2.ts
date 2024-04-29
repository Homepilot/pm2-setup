import path from 'path';
import pm2, { StartOptions } from 'pm2';
import { APP_INFOS, APP_PORTS, COMMON_ENV } from '../apps.config';
import { ENABLED_APPS, FEDERATION_APP_NAME } from '../constants';
import { AppInfo } from '../types';
import { awaitAppReady } from '../utils';


async function pm2StartAsync(pm2AppConfig: StartOptions) {
    return new Promise((resolve, reject) => {
        console.log(`Starting ${pm2AppConfig.name} ...`);
        pm2.start(pm2AppConfig, function (err, apps) {
            if (err) {
                console.error(err);
                reject(err);
            }
            resolve(apps);
        });
    });
}

function appInfoToPm2Config({ name, env, command, runFromAppFolder }: AppInfo): StartOptions {
    const cwd = runFromAppFolder ? path.join(process.cwd(), 'apps', name) : process.cwd();
    const isNestApp = !runFromAppFolder || command === 'yarn start';
    const baseConfig = {
        name,
        cwd,
        script: command ?? `yarn start ${name}`,
        env: {
            ...Object.entries(COMMON_ENV).map(([key, value]) => [key, String(value)]).reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
            ...Object.entries(env).map(([key, value]) => [key, String(value)]).reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
            PORT: String(APP_PORTS[name]),
        },
    }

    if(isNestApp) return baseConfig;

    return {
        ...baseConfig,
        watch: [`${cwd}/src`],
        ignore_watch: ['**/node_modules', '/dist', '**/@generated', '**/generated', '**/schema.gql'],
    };
}

async function handlePm2Connection(err: unknown){
    if (err) {
        console.log('Error connecting to pm2');
        console.error(err);
        process.exit(2);
    }
    console.log('Connected to pm2');

    const appsToStart = APP_INFOS.filter((appInfo) => appInfo.name !== FEDERATION_APP_NAME && ENABLED_APPS.has(appInfo.name));
    const federationService = APP_INFOS.find((app) => app.name === FEDERATION_APP_NAME);

    // Start all apps except federation
    await Promise.all(appsToStart.map(appInfoToPm2Config).map(pm2StartAsync));
    console.log('Waiting for apps federation dependencies to start');
    await Promise.allSettled(appsToStart.map(({ name }) => awaitAppReady(name)));

    // Start federation
    if (federationService && ENABLED_APPS.has(FEDERATION_APP_NAME)) {
        await pm2StartAsync(appInfoToPm2Config(federationService));
        try {
            await awaitAppReady(FEDERATION_APP_NAME);
        } catch (error) {
            console.error('Federation service is not started', error);
        }
    }

    console.log('All apps started');

    pm2.disconnect();
    console.log('Disconnected from pm2');
}

(() => {
    console.log('Starting pm2 apps');
    pm2.connect(handlePm2Connection);
})();
