/*
 * This code snippet needs to be executed at the very beginning of the action.
 * Since the underlying azure-actions-appservice-rest will load the AZURE_HTTP_USER_AGENT
 * environment variable in the initialization.
 * Thus, the AZURE_HTTP_USER_AGENT needs to be set before any rest request.
 */
import * as core from '@actions/core';
import * as crypto from "crypto";
import * as fs from 'fs';
import axios, {isAxiosError} from 'axios';
import { ConfigurationConstant } from './constants/configuration';
const prefix = !!process.env.AZURE_HTTP_USER_AGENT ? `${process.env.AZURE_HTTP_USER_AGENT}` : "";
const usrAgentRepo = crypto.createHash('sha256').update(`${process.env.GITHUB_REPOSITORY}`).digest('hex');
const actionName = ConfigurationConstant.ActionName;
const userAgentString = (!!prefix ? `${prefix}+` : '') + `GITHUBACTIONS_${actionName}_${usrAgentRepo}`;
core.exportVariable('AZURE_HTTP_USER_AGENT', userAgentString);

import { Orchestrator } from './managers/orchestrator';
import { StateConstant } from './constants/state';
import { Initializer } from './handlers/initializer';
import { ParameterValidator } from './handlers/parameterValidator';
import { ResourceValidator } from './handlers/resourceValidator';
import { ContentPreparer } from './handlers/contentPreparer';
import { ContentPublisher } from './handlers/contentPublisher';
import { PublishValidator } from './handlers/publishValidator';
import { Logger } from './utils';
import { UnexpectedExitException, BaseException } from './exceptions';

async function validateSubscription() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'azure/functions-action';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  core.info('');
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body, { timeout: 3000 }
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(`\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`);
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}

async function main(): Promise<void> {
    await validateSubscription();
    const actionManager = new Orchestrator();
    actionManager.register(StateConstant.Initialize, new Initializer());
    actionManager.register(StateConstant.ValidateParameter, new ParameterValidator());
    actionManager.register(StateConstant.ValidateAzureResource, new ResourceValidator());
    actionManager.register(StateConstant.PreparePublishContent, new ContentPreparer());
    actionManager.register(StateConstant.PublishContent, new ContentPublisher());
    actionManager.register(StateConstant.ValidatePublishedContent, new PublishValidator());

    while (!actionManager.isDone) {
        try {
            await actionManager.execute();
        } catch (expt) {
            if (expt instanceof BaseException) {
                expt.PrintTraceback(Logger.Error);
            } else if (expt instanceof Error) {
                Logger.Error(expt.message);
                if (expt.stack) {
                    Logger.Error(expt.stack);
                }
            }
            break;
        }
    }

    switch (actionManager.state) {
        case StateConstant.Succeeded:
            core.debug("Deployment Succeeded!");
            return
        case StateConstant.Failed:
            core.setFailed("Deployment Failed!");
            return
        default:
            const expt = new UnexpectedExitException(actionManager.state);
            core.setFailed(expt.message);
            throw expt;
    }
}

main();