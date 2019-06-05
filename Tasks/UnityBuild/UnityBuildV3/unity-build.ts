import path = require('path');
import tl = require('azure-pipelines-task-lib/task');
import fs = require('fs-extra');
import { isNullOrUndefined } from 'util';
import { UnityBuildTarget } from './unity-build-target.enum';
import { UnityBuildScriptHelper } from './unity-build-script.helper';
import { UnityBuildConfiguration } from './unity-build-configuration.model';

tl.setResourcePath(path.join(__dirname, 'task.json'));

async function run() {
    try {
        const unityBuildConfiguration = getBuildConfiguration();
        const unityEditorsPath = getUnityEditorsPath();

        // Make sure the selected editor exists.
        const unityEditorDirectory = process.platform === 'win32' ?
            path.join(`${unityEditorsPath}`, `${unityBuildConfiguration.unityVersion}`, 'Editor')
            : path.join(`${unityEditorsPath}`, `${unityBuildConfiguration.unityVersion}`);
        tl.checkPath(unityEditorDirectory, 'Unity Editor Directory');

        // Here we make sure the build output directory exists and we can export Unity artifacts
        // there. If the folder already exists, we'll delete it so we get a clean build.
        const cleanBuild = tl.getVariable('Build.Repository.Clean');
        const repositoryLocalPath = tl.getVariable('Build.Repository.LocalPath');
        const buildOutputDir = UnityBuildScriptHelper.getBuildOutputDirectory(unityBuildConfiguration.buildTarget);
        const fullBuildOutputPath = path.join(`${unityBuildConfiguration.projectPath}`, `${buildOutputDir}`)

        if (cleanBuild === 'true') {
            fs.removeSync(fullBuildOutputPath);
        }

        tl.mkdirP(fullBuildOutputPath);
        tl.checkPath(fullBuildOutputPath, 'Build Output Directory');
        tl.setVariable('buildOutputPath', fullBuildOutputPath.substr(repositoryLocalPath.length + 1));

        // Mandatory set of command line arguments for Unity.
        // -batchmode will open Unity without UI
        // -buildTarget sets the configured target platform
        // -projectPath tell Unity which project to load
        const unityExecutablePath = process.platform === 'win32' ? path.join(`${unityEditorDirectory}`, 'Unity.exe')
            : path.join(`${unityEditorDirectory}`, 'Unity.app', 'Contents', 'MacOS', 'Unity');
        const unityCmd = tl.tool(unityExecutablePath)
            .arg('-batchmode')
            .arg('-buildTarget').arg(UnityBuildTarget[unityBuildConfiguration.buildTarget])
            .arg('-projectPath').arg(unityBuildConfiguration.projectPath);

        if (tl.getInput('commandLineArgumentsMode', true) === 'default') {
            if (tl.getBoolInput('noPackageManager')) {
                unityCmd.arg('-noUpm');
            }

            if (tl.getBoolInput('acceptApiUpdate')) {
                unityCmd.arg('-accept-apiupdate');
            }

            if (tl.getBoolInput('noGraphics')) {
                unityCmd.arg('-nographics');
            }

            // When using the default command line arguments set, we rely on having a C# script
            // in the Unity project to trigger the build. This C# script is generated here based on the
            // tasks configuration and then "injected" into the project before Unity launches. This way it will
            // be available to us and we can Invoke it using the command line.
            const projectAssetsEditorFolderPath = path.join(`${unityBuildConfiguration.projectPath}`, 'Assets', 'Editor');
            tl.mkdirP(projectAssetsEditorFolderPath);
            tl.cd(projectAssetsEditorFolderPath);
            tl.writeFile('AzureDevOps.cs', UnityBuildScriptHelper.getUnityEditorBuildScriptContent(unityBuildConfiguration));
            tl.cd(unityBuildConfiguration.projectPath);
            unityCmd.arg('-executeMethod');
            unityCmd.arg('AzureDevOps.PerformBuild');

            // Optionally add a logfile definition to the command and output the logfile to the build output directory.
            const logFileName = tl.getInput('logFileName', false);
            if (logFileName && logFileName !== '') {
                const logFilePath = path.join(repositoryLocalPath, logFileName);
                unityCmd.arg('-logfile');
                unityCmd.arg(logFilePath);
                tl.setVariable('editorLogFilePath', logFilePath);
            }

        } else {
            // The user has configured to use his own custom command line arguments.
            // In this case, just append them to the mandatory set of arguments and we're done.
            unityCmd.line(tl.getInput('customCommandLineArguments'));
        }

        // Now we are ready to execute the Unity command line.
        // Unfortuntely, the command line will return before the unity build has actually finished, and eventually
        // give us a false positive. The solution is currently to observe whether the Unity process is still running,
        // and when done, check whether there are output files.
        unityCmd.execSync();

        // TODO: Check result.
    } catch (err) {
        setResultFailed(err.message);
    }
}

function getBuildConfiguration(): UnityBuildConfiguration {
    const unityBuildConfiguration: UnityBuildConfiguration = new UnityBuildConfiguration();
    unityBuildConfiguration.outputFileName = tl.getInput('outputFileName');
    unityBuildConfiguration.developmentBuild = tl.getBoolInput('developmentBuild');
    unityBuildConfiguration.buildScenes = tl.getInput('buildScenes');
    unityBuildConfiguration.buildTarget = (<any>UnityBuildTarget)[tl.getInput('buildTarget', true)];
    unityBuildConfiguration.projectPath = tl.getPathInput('unityProjectPath');

    let unityVersion = fs.readFileSync(path.join(`${unityBuildConfiguration.projectPath}`, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')
        .toString()
        .split(':')[1]
        .trim();

    const revisionVersionIndex = unityVersion.indexOf('m_EditorVersionWithRevision');
    if (revisionVersionIndex > -1) {
        // The ProjectVersion.txt contains a revision version. We need to drop it.
        unityVersion = unityVersion.substr(0, revisionVersionIndex).trim();
    }

    unityBuildConfiguration.unityVersion = unityVersion;

    if (isNullOrUndefined(unityBuildConfiguration.unityVersion) || unityBuildConfiguration.unityVersion === '') {
        throw Error('Failed to get project version from ProjectVersion.txt file.');
    }

    if (process.platform !== 'win32' && unityBuildConfiguration.buildTarget === UnityBuildTarget.WindowsStoreApps) {
        throw Error('Cannot build an UWP project on a Mac.');
    }

    return unityBuildConfiguration;
}

function getUnityEditorsPath(): string {
    const editorsPathMode = tl.getInput('unityEditorsPathMode', true);
    if (editorsPathMode === 'unityHub') {
        const unityHubPath = process.platform === 'win32' ?
            path.join('C:', 'Program Files', 'Unity', 'Hub', 'Editor')
            : path.join('/', 'Applications', 'Unity', 'Hub', 'Editor');

        return unityHubPath;
    } else if (editorsPathMode === 'environmentVariable') {
        const environmentVariablePath = process.env.UNITYHUB_EDITORS_FOLDER_LOCATION as string;
        if (isNullOrUndefined(environmentVariablePath) || environmentVariablePath === '') {
            throw Error('Expected UNITYHUB_EDITORS_FOLDER_LOCATION environment variable to be set!');
        }

        return environmentVariablePath;
    } else {
        const customPath = tl.getInput('customUnityEditorsPath');
        if (isNullOrUndefined(customPath) || customPath === '') {
            throw Error('Expected custom editors folder location to be set. Please the task configuration.');
        }

        return customPath;
    }
}

function setResultFailed(msg: string): void {
    tl.setResult(tl.TaskResult.Failed, msg);
}

function setResultSucceeded(msg: string): void {
    tl.setResult(tl.TaskResult.Succeeded, msg);
}

run();