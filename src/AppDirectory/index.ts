const os = require('os');
const path = require('path');

export interface IAppDirectory {
    col: string;
    platform: string;
    userData: () => string;
}

export class AppDirectory implements IAppDirectory {
    public col: string;
    public platform: string;
    public dir: string | null;

    constructor(colName: string, dir: string | null) {
        this.col = colName;
        this.platform = os.platform();
        this.dir = dir;
    }

    public userData() {
        let dataPath: string;

        // custom data dir save
        if (this.dir != "" && this.dir != null && this.dir.length > 0) {
            return path.join(`${this.dir}`, `${this.col}`)
        }

        if (this.platform === 'darwin') {
            dataPath = path.join(os.homedir(), 'Library', 'Application Support', `${this.col}`);
        } else if (this.platform === 'win32') {
            dataPath = path.join(os.homedir(), 'AppData', 'Local', `${this.col}`);
        } else if (this.platform === 'linux') {
            dataPath = path.join(os.homedir(), '.local', 'share', `${this.col}`);
        } else {
            dataPath = '';
        }
        return dataPath;
    }
}
