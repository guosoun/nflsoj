import * as TypeORM from "typeorm";
import Model from "./common";

@TypeORM.Entity()
export default class UserNote extends Model {
    static cache = true;

    @TypeORM.PrimaryGeneratedColumn()
    id: number;

    @TypeORM.Column({ type: "integer" })
    user_id: number;

    @TypeORM.Column({ nullable: true, type: "text"})
    note: string;

    @TypeORM.Column({ nullable: true, type: "integer" })
    created_time: number;
};
